import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { Capabilities, Control, ControlOption } from '../domain/Capabilities.ts';
import {
  BackgroundRun,
  ConversationPage,
  MessageEvent,
  NoticeEvent,
  ToolCall,
  ToolEvent,
  type AgentEvent,
  type SessionMatch,
  type ToolKind,
} from '../domain/Event.ts';
import { buildDiff, wholeFileDiff } from '../domain/diff.ts';
import { HerdrRpc } from '../services/HerdrRpc.ts';
import { Transcript, type Consumer } from '../services/Transcript.ts';
import { AdapterError, type Adapter, type PaneInfo } from './Adapter.ts';
import { Ledger } from './Ledger.ts';

/**
 * Claude Code.
 *
 * It keeps one JSON object per line under ~/.claude/projects, and that file is
 * the conversation: prose, every tool call with its arguments, every result
 * with the file as it stood before the edit, and the whole life of a task left
 * running in the background. Almost nothing has to be guessed, which is why
 * this is the adapter the others are measured against.
 *
 * Everything below was read off real transcripts rather than remembered.
 */

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');

/** How Claude Code names a directory's folder: anything but a letter or digit becomes a dash. */
const projectSlug = (cwd: string): string => cwd.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-');

/** Turns Claude Code files as the user's without the user having typed them. */
const BOOKKEEPING =
  /^\s*(<(command-name|command-message|command-args|local-command|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)|\[Request interrupted)/;

// ------------------------------------------------------------------ locating

const exists = (file: string) =>
  Effect.tryPromise(() => fs.access(file)).pipe(Effect.as(true), Effect.orElseSucceed(() => false));

const transcriptBySession = (sessionId: string | undefined) =>
  Effect.gen(function* () {
    if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
    const folders = yield* Effect.tryPromise(() => fs.readdir(PROJECTS_DIR)).pipe(
      Effect.orElseSucceed(() => [] as string[]),
    );
    for (const folder of folders) {
      const candidate = path.join(PROJECTS_DIR, folder, `${sessionId}.jsonl`);
      if (yield* exists(candidate)) return candidate;
    }
    return null;
  });

/** Claude Code leaves a note per process saying which session it is running. */
const sessionOfProcess = (pid: number) =>
  Effect.tryPromise(() =>
    fs.readFile(path.join(SESSIONS_DIR, `${pid}.json`), 'utf8').then(
      (raw) => (JSON.parse(raw) as { sessionId?: string }).sessionId ?? null,
    ),
  ).pipe(Effect.orElseSucceed(() => null));

const newestTranscriptFor = (cwd: string) =>
  Effect.tryPromise(async () => {
    const folder = path.join(PROJECTS_DIR, projectSlug(cwd));
    const names = await fs.readdir(folder);
    const stats = await Promise.all(
      names
        .filter((n) => n.endsWith('.jsonl'))
        .map(async (n) => {
          const full = path.join(folder, n);
          return { full, at: (await fs.stat(full)).mtimeMs };
        }),
    );
    if (stats.length === 0) return null;
    return stats.sort((a, b) => b.at - a.at)[0].full;
  }).pipe(Effect.orElseSucceed(() => null));

interface Located {
  readonly file: string;
  readonly match: SessionMatch;
  readonly session: string;
}

// ------------------------------------------------------------------ describing

const basename = (value: unknown): string => {
  const text = String(value ?? '').replace(/[\\/]+$/, '');
  return path.basename(text) || text;
};

/** One line per call, plus the shape of card the app should draw. */
function describeTool(
  name: string,
  input: Record<string, unknown>,
): { kind: ToolKind; title: string; path?: string } {
  const file = typeof input.file_path === 'string' ? input.file_path : undefined;
  switch (name) {
    case 'Read':
      return { kind: 'read', title: `Letto ${basename(file)}`, path: file };
    case 'Edit':
      return { kind: 'edit', title: `Modificato ${basename(file)}`, path: file };
    case 'Write':
      return { kind: 'write', title: `Scritto ${basename(file)}`, path: file };
    case 'NotebookEdit':
      return { kind: 'edit', title: `Modificato ${basename(input.notebook_path)}`, path: String(input.notebook_path ?? '') };
    case 'Bash':
    case 'PowerShell': {
      const described = typeof input.description === 'string' ? input.description : '';
      const command = String(input.command ?? '').slice(0, 80);
      return { kind: 'shell', title: (described || command || name).trim() };
    }
    case 'Grep':
    case 'Glob':
      return { kind: 'search', title: `Cercato ${String(input.pattern ?? '')}`.slice(0, 100) };
    case 'Agent':
      return { kind: 'task', title: `Agente: ${input.description ?? ''}`.replace(/[:\s]+$/, '') };
    case 'Task':
      return { kind: 'task', title: `Attività: ${input.description ?? ''}`.replace(/[:\s]+$/, '') };
    case 'WebFetch':
      return { kind: 'web', title: `Aperto ${String(input.url ?? '')}`.slice(0, 100) };
    case 'WebSearch':
      return { kind: 'web', title: `Cercato sul web: ${String(input.query ?? '')}`.slice(0, 100) };
    case 'Skill':
      return { kind: 'task', title: `Skill ${String(input.skill ?? '')}` };
    case 'SendUserFile':
      return { kind: 'other', title: `Inviato ${basename(input.path ?? input.file_path)}` };
    default:
      // MCP tools arrive as mcp__server__tool; the middle part is the useful half.
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return { kind: 'other', title: `${tool ?? name} · ${server ?? 'mcp'}` };
      }
      return { kind: 'other', title: name };
  }
}

// -------------------------------------------------------------------- parsing

interface State {
  ledger: Ledger;
  /** Calls waiting for their result, so a later line can complete them. */
  byToolId: Map<string, ToolEvent>;
  /** Background runs by the id Claude Code hands out, so the end can be matched. */
  byTaskId: Map<string, ToolEvent>;
  /** Blocks of one reply arrive as separate lines; they are one message. */
  lastAssistant?: { mid: string; event: MessageEvent };
  permissionMode?: string;
};

const push = <E extends AgentEvent>(state: State, make: (seq: number) => E): E =>
  state.ledger.push(make);

/**
 * Swaps a tool event for a newer one and keeps the lookups pointing at it. The
 * ledger handles the numbering; what belongs here is only the bookkeeping this
 * agent needs — a call is found again by its own id, and a background run by
 * the task id Claude Code hands out.
 */
const replace = (state: State, previous: ToolEvent, next: ToolEvent) => {
  state.ledger.replace(previous, next);
  state.byToolId.set(next.call.id, next);
  const task = next.call.background?.id;
  if (task) state.byTaskId.set(task, next);
};

const TASK_NOTIFICATION = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/;

function consume(state: State, line: string): void {
  // The cheap check first: most of a transcript is bookkeeping, and parsing
  // hundreds of megabytes of JSON only to throw it away is the one thing that
  // would make this too slow to run on every poll.
  //
  // The marker has to be `role`, not `type`. In an assistant entry the message
  // is written before the entry's own type, so `"type":"assistant"` lands at
  // the far end of a line that can be tens of kilobytes long, while
  // `"role":"assistant"` sits inside the first two hundred characters.
  const head = line.slice(0, 700);
  const looksLikeTurn = head.includes('"role":"user"') || head.includes('"role":"assistant"');
  const isQueue = head.includes('"type":"queue-operation"');
  const isPermission = head.includes('"type":"permission-mode"');
  if (!looksLikeTurn && !isQueue && !isPermission) return;

  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }

  if (entry.type === 'permission-mode') {
    if (typeof entry.permissionMode === 'string') state.permissionMode = entry.permissionMode;
    return;
  }

  // A background run ends with a queued task notification carrying its verdict.
  if (entry.type === 'queue-operation') {
    if (entry.operation !== 'enqueue') return;
    const found = TASK_NOTIFICATION.exec(String(entry.content ?? ''));
    if (!found) return;
    const [, taskId, status] = found;
    const event = state.byTaskId.get(taskId);
    if (!event?.call.background) return;
    replace(
      state,
      event,
      new ToolEvent({
        ...event,
        call: new ToolCall({
          ...event.call,
          status: status === 'completed' ? 'ok' : 'error',
          error: status === 'completed' ? undefined : `L'attività in background è terminata: ${status}`,
          background: new BackgroundRun({
            ...event.call.background,
            endedAt: String(entry.timestamp ?? ''),
          }),
        }),
      }),
    );
    return;
  }

  if (entry.isSidechain === true || entry.isMeta === true) return;
  const message = entry.message ?? {};
  const content = message.content;
  const time = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

  if (entry.type === 'assistant') {
    if (!Array.isArray(content)) return;
    const mid = typeof message.id === 'string' ? message.id : undefined;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text' && String(block.text ?? '').trim()) {
        const text = String(block.text).trim();
        // Same message id as the block before it: one reply, split over lines.
        const open = state.lastAssistant;
        if (mid && open && open.mid === mid) {
          const merged = state.ledger.replace(
            open.event,
            new MessageEvent({ ...open.event, text: `${open.event.text}\n\n${text}` }),
          );
          state.lastAssistant = { mid, event: merged };
          continue;
        }
        const event = push(state, (seq) => new MessageEvent({ seq, role: 'assistant', text, time }));
        if (mid) state.lastAssistant = { mid, event };
        continue;
      }

      if (block.type === 'tool_use') {
        const name = String(block.name ?? '');
        const input = (block.input ?? {}) as Record<string, unknown>;
        const described = describeTool(name, input);
        const event = push(
          state,
          (seq) =>
            new ToolEvent({
              seq,
              time,
              call: new ToolCall({
                id: String(block.id ?? `${seq}`),
                name,
                kind: described.kind,
                title: described.title,
                status: 'running',
                params: input,
                path: described.path,
              }),
            }),
        ) as ToolEvent;
        state.byToolId.set(event.call.id, event);
        state.lastAssistant = undefined;
      }
    }
    return;
  }

  // -------- user entries: a real message, a tool result, or a compaction

  // `attachment` and `last-prompt` entries carry a role too; only a real turn
  // gets past here.
  if (entry.type !== 'user') return;

  if (entry.isCompactSummary) {
    push(
      state,
      (seq) =>
        new NoticeEvent({
          seq,
          kind: 'compaction',
          text: "Contesto riassunto: da qui l'agente ricorda solo un riepilogo.",
          time,
        }),
    );
    return;
  }

  const results = Array.isArray(content)
    ? content.filter((b: any) => b && typeof b === 'object' && b.type === 'tool_result')
    : [];

  if (results.length > 0) {
    for (const block of results) {
      const event = state.byToolId.get(String(block.tool_use_id ?? ''));
      if (!event) continue;
      completeCall(state, event, block, entry.toolUseResult, time);
    }
    return;
  }

  let text = '';
  let images = 0;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((b: any) => b && typeof b === 'object' && b.type === 'text')
      .map((b: any) => String(b.text ?? ''))
      .join('\n');
    images = content.filter((b: any) => b && typeof b === 'object' && b.type === 'image').length;
  } else {
    return;
  }
  text = text.trim();
  if ((!text && images === 0) || BOOKKEEPING.test(text)) return;
  push(state, (seq) => new MessageEvent({ seq, role: 'user', text, images: images || undefined, time }));
  state.lastAssistant = undefined;
}

/** Fills in what only the result knows: whether it worked, the diff, the background id. */
function completeCall(
  state: State,
  event: ToolEvent,
  block: any,
  toolUseResult: any,
  time: string | undefined,
): void {
  const failed = block.is_error === true;
  const call = event.call;

  // A backgrounded command answers at once with its task id and keeps running:
  // the call is not finished, it has only been handed over.
  const taskId = toolUseResult?.backgroundTaskId;
  if (typeof taskId === 'string' && taskId) {
    replace(
      state,
      event,
      new ToolEvent({
        ...event,
        call: new ToolCall({
          ...call,
          status: 'running',
          background: new BackgroundRun({ id: taskId, startedAt: event.time ?? time ?? '' }),
        }),
      }),
    );
    return;
  }

  let diff = call.diff;
  if (!diff && call.kind === 'edit' && typeof toolUseResult?.oldString === 'string') {
    diff = buildDiff({
      path: String(toolUseResult.filePath ?? call.path ?? ''),
      before: toolUseResult.oldString,
      after: String(toolUseResult.newString ?? ''),
      // The result carries the file as it stood, so the numbers down the side
      // are the file's own and not a count from the top of the change.
      fileText: typeof toolUseResult.originalFile === 'string' ? toolUseResult.originalFile : undefined,
    });
  }
  if (!diff && call.kind === 'write' && typeof call.params.content === 'string') {
    diff = wholeFileDiff(String(call.path ?? ''), call.params.content);
  }

  replace(
    state,
    event,
    new ToolEvent({
      ...event,
      call: new ToolCall({
        ...call,
        status: failed ? 'error' : 'ok',
        diff,
        error: failed ? String(block.content ?? '').slice(0, 300) : undefined,
      }),
    }),
  );
}

const consumer: Consumer<State> = {
  init: () => ({
    ledger: new Ledger(),
    byToolId: new Map(),
    byTaskId: new Map(),
  }),
  consume,
};

// --------------------------------------------------------------- capabilities

/**
 * The controls Claude Code actually answers to.
 *
 * Every option here is a real slash command — `/model`, `/effort` and their
 * arguments were taken from sessions on this machine, not from memory. A pill
 * that sends a command the agent does not know is worse than no pill, so
 * nothing speculative belongs in this list.
 */
const capabilitiesFor = (permissionMode: string | undefined): Capabilities =>
  new Capabilities({
    id: 'claude-code',
    label: 'Claude Code',
    structured: true,
    slashCommands: true,
    backgroundTasks: true,
    toolResults: true,
    diffs: true,
    fileReference: 'at-path',
    interruptKeys: ['Escape'],
    controls: [
      new Control({
        id: 'model',
        label: 'Modello',
        placeholder: 'Modello',
        // No trailing newline in `send`: an agent's input treats a burst of
        // characters ending in one as a paste and keeps it as text. The app
        // types the line and presses Enter as two events, the way it does for
        // a message.
        options: [
          new ControlOption({ id: 'fable', label: 'Fable 5.1', send: '/model fable' }),
          new ControlOption({ id: 'opus', label: 'Opus 5', send: '/model opus' }),
          new ControlOption({ id: 'sonnet', label: 'Sonnet 5', send: '/model sonnet' }),
          new ControlOption({ id: 'haiku', label: 'Haiku 4.5', send: '/model haiku' }),
        ],
      }),
      new Control({
        id: 'effort',
        label: 'Impegno',
        options: [
          new ControlOption({ id: 'low', label: 'Basso', send: '/effort low' }),
          new ControlOption({ id: 'medium', label: 'Medio', send: '/effort medium' }),
          new ControlOption({ id: 'high', label: 'Alto', note: 'Predefinito', send: '/effort high' }),
          new ControlOption({ id: 'max', label: 'Max', send: '/effort max' }),
        ],
      }),
      new Control({
        id: 'permission',
        label: 'Autorizzazione',
        current: permissionMode,
        options: [
          new ControlOption({ id: 'default', label: 'Chiedi conferma', send: '' }),
          new ControlOption({ id: 'bypassPermissions', label: 'Ignora controlli', send: '' }),
        ],
      }),
    ],
  });

// ------------------------------------------------------------------- assembly

/**
 * Builds the adapter with its services already closed over, so the registry can
 * hold a plain value and order it against the others without carrying their
 * requirements around.
 */
export const make: Effect.Effect<Adapter, never, HerdrRpc | Transcript> = Effect.gen(
  function* () {
    const rpc = yield* HerdrRpc;
    const transcript = yield* Transcript;
    const cache = new Map<string, { at: number; found: Located | null }>();
    const CACHE_TTL = 60_000;

    /** The transcript behind a pane: by session id, by process, else the newest here. */
    const locate = (pane: PaneInfo): Effect.Effect<Located | null> =>
      Effect.gen(function* () {
        const cached = cache.get(pane.paneId);
        if (cached && cached.at > Date.now()) return cached.found;

        let found: Located | null = null;

        const bySession = yield* transcriptBySession(pane.agentSession);
        if (bySession) found = { file: bySession, match: 'session', session: pane.agentSession! };

        if (!found) {
          const info: any = yield* rpc.callOption('pane.process_info', { pane_id: pane.paneId });
          const processes = info?.process_info?.foreground_processes ?? [];
          for (const proc of processes) {
            if (!String(proc?.name ?? '').toLowerCase().startsWith('claude')) continue;
            const session = yield* sessionOfProcess(Number(proc.pid));
            const file = yield* transcriptBySession(session ?? undefined);
            if (file) {
              found = { file, match: 'process', session: session! };
              break;
            }
          }
        }

        if (!found && pane.cwd) {
          const file = yield* newestTranscriptFor(pane.cwd);
          if (file) found = { file, match: 'cwd', session: path.basename(file, '.jsonl') };
        }

        cache.set(pane.paneId, { at: Date.now() + CACHE_TTL, found });
        return found;
      });

    const adapter: Adapter = {
      id: 'claude-code',
      label: 'Claude Code',

      /**
       * Only a session id or a live `claude` process counts as proof. Matching
       * on the directory alone would claim every plain shell opened in a folder
       * Claude Code once worked in, and then show it somebody else's history.
       */
      detect: (pane) =>
        Effect.gen(function* () {
          if (String(pane.agent ?? '').toLowerCase().startsWith('claude')) return true;
          const located = yield* locate(pane);
          return located !== null && located.match !== 'cwd';
        }),

      capabilities: (pane) =>
        Effect.gen(function* () {
          const located = yield* locate(pane);
          if (!located) return capabilitiesFor(undefined);
          const state = yield* transcript
            .read(located.file, consumer)
            .pipe(Effect.orElseSucceed(() => undefined));
          return capabilitiesFor(state?.permissionMode);
        }),

      conversation: (pane, since) =>
        Effect.gen(function* () {
          const located = yield* locate(pane);
          if (!located) {
            return yield* new AdapterError({
              adapter: 'claude-code',
              reason: 'nessuna trascrizione per questa finestra',
            });
          }
          const state = yield* transcript.read(located.file, consumer).pipe(
            Effect.mapError((cause) => new AdapterError({ adapter: 'claude-code', reason: cause.reason })),
          );
          return new ConversationPage({
            paneId: pane.paneId,
            agent: 'claude-code',
            session: located.session,
            match: located.match,
            total: state.ledger.events.length,
            rev: state.ledger.revision,
            // Whatever changed since the app last looked, appended or amended.
            events: state.ledger.changedSince(since),
          });
        }),
    };

    return adapter;
  },
);
