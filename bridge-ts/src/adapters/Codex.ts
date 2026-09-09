import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { Capabilities, Control, ControlOption } from '../domain/Capabilities.ts';
import {
  ConversationPage,
  MessageEvent,
  NoticeEvent,
  ToolCall,
  ToolEvent,
  type SessionMatch,
  type ToolKind,
} from '../domain/Event.ts';
import { parseUnifiedDiff } from '../domain/diff.ts';
import { Transcript, type Consumer } from '../services/Transcript.ts';
import { AdapterError, type Adapter, type PaneInfo } from './Adapter.ts';
import { Ledger } from './Ledger.ts';

/**
 * OpenAI Codex CLI.
 *
 * It writes a rollout per session under ~/.codex/sessions/yyyy/mm/dd, one
 * JSON line per event, and Herdr's hook reports the session id for the pane.
 * The file name ends in that id, so finding it is a walk of the date folders.
 *
 * What the reader wants is in two layers of the file. The conversation is in
 * `event_msg` lines — the user's message and the agent's, already plain. The
 * tool calls are `response_item` lines paired by call id. And an edit is
 * reported when it lands, as `patch_apply_end`, with a unified diff per file:
 * the numbering is Codex's own, and nothing has to be searched for.
 */

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

// ------------------------------------------------------------------- locating

interface Rollout {
  readonly file: string;
  readonly mtime: number;
}

/** Every rollout on disk, newest first. The tree is shallow: year, month, day. */
const listRollouts = Effect.tryPromise(async () => {
  const found: Rollout[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
      } else if (entry.name.endsWith('.jsonl')) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) found.push({ file: full, mtime: stat.mtimeMs });
      }
    }
  };
  await walk(SESSIONS, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}).pipe(Effect.orElseSucceed(() => [] as Rollout[]));

/** The directory a rollout was started in, from its first line. */
const cwdOf = (file: string) =>
  Effect.tryPromise(async () => {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
      const head = buffer.toString('utf8', 0, bytesRead);
      const line = head.slice(0, head.indexOf('\n') === -1 ? undefined : head.indexOf('\n'));
      const meta = JSON.parse(line) as { payload?: { cwd?: string } };
      return typeof meta.payload?.cwd === 'string' ? meta.payload.cwd : null;
    } finally {
      await handle.close();
    }
  }).pipe(Effect.orElseSucceed(() => null));

const normalizeDir = (dir: string) => path.resolve(dir).replace(/[\\/]+$/, '').toLowerCase();

// ------------------------------------------------------------------ describing

const basename = (value: unknown): string => {
  const text = String(value ?? '').replace(/[\\/]+$/, '');
  return path.basename(text) || text;
};

/** The first file a patch names, so an apply_patch call has a path before its diff arrives. */
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;

function describeTool(
  name: string,
  args: Record<string, unknown>,
): { kind: ToolKind; title: string; path?: string } {
  const command = Array.isArray(args.command)
    ? args.command.map(String).join(' ')
    : typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string'
        ? args.cmd
        : '';
  switch (name) {
    case 'shell':
    case 'shell_command':
    case 'exec_command':
    case 'container.exec':
      return { kind: 'shell', title: (command || name).slice(0, 80) };
    case 'apply_patch': {
      const file = PATCH_FILE.exec(String(args.input ?? args.patch ?? ''))?.[1]?.trim();
      return { kind: 'edit', title: `Modificato ${basename(file)}`, path: file };
    }
    case 'read_file':
    case 'view_image':
      return { kind: 'read', title: `Letto ${basename(args.path ?? args.file_path)}`, path: String(args.path ?? args.file_path ?? '') || undefined };
    case 'write_file':
      return { kind: 'write', title: `Scritto ${basename(args.path ?? args.file_path)}`, path: String(args.path ?? args.file_path ?? '') || undefined };
    case 'grep':
    case 'rg':
    case 'list_dir':
    case 'glob':
      return { kind: 'search', title: `Cercato ${String(args.pattern ?? args.query ?? args.path ?? '')}`.slice(0, 100) };
    case 'web_search':
      return { kind: 'web', title: `Cercato sul web: ${String(args.query ?? '')}`.slice(0, 100) };
    case 'spawn_agent':
    case 'send_message':
    case 'wait_for_agent':
      return { kind: 'task', title: `Sub-agente: ${String(args.name ?? args.agent ?? args.task ?? '')}`.replace(/[:\s]+$/, '') };
    case 'update_plan':
      return { kind: 'other', title: 'Piano aggiornato' };
    case 'wait':
      return { kind: 'other', title: 'In attesa di un comando' };
    default:
      return { kind: 'other', title: name.replace(/_/g, ' ') };
  }
}

/** The command inside an `exec` cell: the script is boilerplate around it. */
const CELL_COMMAND = /shell_command\(\s*\{\s*command\s*:\s*"((?:[^"\\]|\\.)*)"/;

const unescape = (text: string) =>
  text.replace(/\\(["\\nrt])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
  );

// -------------------------------------------------------------------- parsing

interface State {
  ledger: Ledger;
  byCallId: Map<string, ToolEvent>;
  bySubAgent: Map<string, ToolEvent>;
  cwd?: string;
  model?: string;
  /** The last quota bucket announced: 80, 90 or 100, so the notice is not repeated every turn. */
  limitBucket?: number;
}

const complete = (state: State, event: ToolEvent, output: string, failed: boolean) => {
  const next = state.ledger.replace(
    event,
    new ToolEvent({
      ...event,
      call: new ToolCall({
        ...event.call,
        status: failed ? 'error' : 'ok',
        error: failed ? output.slice(0, 300) : undefined,
      }),
    }),
  );
  state.byCallId.set(next.call.id, next);
};

const looksFailed = (output: string) =>
  /^(error|traceback|command failed)/im.test(output) || /"exit_code":\s*[1-9]/.test(output);

const outputText = (output: unknown): string =>
  typeof output === 'string'
    ? output
    : Array.isArray(output)
      ? output.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
      : '';

function consume(state: State, line: string): void {
  if (!line.includes('"type":"')) return;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const payload = entry.payload ?? {};
  const time = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  const key = `${entry.type}/${payload.type ?? ''}`;

  switch (key) {
    case 'session_meta/': {
      if (typeof payload.cwd === 'string') state.cwd = payload.cwd;
      return;
    }
    case 'turn_context/': {
      if (typeof payload.model === 'string') state.model = payload.model;
      return;
    }

    case 'event_msg/user_message': {
      const text = String(payload.message ?? '').trim();
      const images = (payload.images?.length ?? 0) + (payload.local_images?.length ?? 0);
      if (!text && images === 0) return;
      state.ledger.push(
        (seq) => new MessageEvent({ seq, role: 'user', text, images: images || undefined, time }),
      );
      return;
    }
    case 'event_msg/agent_message': {
      const text = String(payload.message ?? '').trim();
      if (text) state.ledger.push((seq) => new MessageEvent({ seq, role: 'assistant', text, time }));
      return;
    }

    case 'response_item/function_call': {
      const name = String(payload.name ?? '');
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(payload.arguments ?? '{}'));
        if (parsed && typeof parsed === 'object') args = parsed;
      } catch {
        args = { arguments: payload.arguments };
      }
      const described = describeTool(name, args);
      const id = String(payload.call_id ?? payload.id ?? '');
      const event = state.ledger.push(
        (seq) =>
          new ToolEvent({
            seq,
            time,
            call: new ToolCall({
              id: id || `${seq}`,
              name,
              kind: described.kind,
              title: described.title,
              status: 'running',
              params: args,
              path: described.path,
            }),
          }),
      );
      state.byCallId.set(event.call.id, event);
      return;
    }
    case 'response_item/custom_tool_call': {
      const input = String(payload.input ?? '');
      const command = CELL_COMMAND.exec(input)?.[1];
      const id = String(payload.call_id ?? payload.id ?? '');
      const event = state.ledger.push(
        (seq) =>
          new ToolEvent({
            seq,
            time,
            call: new ToolCall({
              id: id || `${seq}`,
              name: String(payload.name ?? 'exec'),
              kind: 'shell',
              title: (command ? unescape(command) : input).slice(0, 80) || 'Script eseguito',
              status: 'running',
              params: { input },
            }),
          }),
      );
      state.byCallId.set(event.call.id, event);
      return;
    }
    case 'response_item/function_call_output':
    case 'response_item/custom_tool_call_output': {
      const event = state.byCallId.get(String(payload.call_id ?? ''));
      if (!event) return;
      const output = outputText(payload.output);
      complete(state, event, output, looksFailed(output));
      return;
    }

    case 'event_msg/patch_apply_end': {
      const changes = payload.changes && typeof payload.changes === 'object' ? payload.changes : {};
      const succeeded = payload.success !== false;
      const pending = state.byCallId.get(String(payload.call_id ?? ''));
      let first = true;
      for (const [file, change] of Object.entries(changes as Record<string, any>)) {
        const diff = parseUnifiedDiff(file, String(change?.unified_diff ?? ''));
        const verb = change?.type === 'add' ? 'Creato' : change?.type === 'delete' ? 'Eliminato' : 'Modificato';
        const title = `${verb} ${basename(file)}`;
        if (first && pending) {
          // The apply_patch call that announced this edit gets its diff, and
          // its result, in one go.
          const next = state.ledger.replace(
            pending,
            new ToolEvent({
              ...pending,
              call: new ToolCall({
                ...pending.call,
                title,
                path: file,
                diff,
                status: succeeded ? 'ok' : 'error',
                error: succeeded ? undefined : String(payload.stderr ?? '').slice(0, 300),
              }),
            }),
          );
          state.byCallId.set(next.call.id, next);
        } else {
          state.ledger.push(
            (seq) =>
              new ToolEvent({
                seq,
                time,
                call: new ToolCall({
                  id: `${String(payload.call_id ?? seq)}:${file}`,
                  name: 'apply_patch',
                  kind: change?.type === 'add' ? 'write' : 'edit',
                  title,
                  status: succeeded ? 'ok' : 'error',
                  params: {},
                  path: file,
                  diff,
                }),
              }),
          );
        }
        first = false;
      }
      return;
    }

    case 'event_msg/context_compacted': {
      state.ledger.push(
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
    case 'event_msg/turn_aborted': {
      if (payload.reason === 'interrupted') {
        state.ledger.push(
          (seq) => new NoticeEvent({ seq, kind: 'interrupted', text: 'Risposta interrotta.', time }),
        );
      }
      return;
    }
    case 'event_msg/token_count': {
      const primary = payload.rate_limits?.primary;
      const percent = Number(primary?.used_percent);
      if (!Number.isFinite(percent) || percent < 80) return;
      const bucket = percent >= 100 ? 100 : percent >= 90 ? 90 : 80;
      if (bucket === state.limitBucket) return;
      state.limitBucket = bucket;
      const resets = Number(primary?.resets_at);
      state.ledger.push(
        (seq) =>
          new NoticeEvent({
            seq,
            kind: 'limit',
            text: bucket >= 100 ? 'Limite di utilizzo raggiunto.' : `Limite di utilizzo al ${Math.round(percent)}%.`,
            resetsAt: Number.isFinite(resets) && resets > 0 ? new Date(resets * 1000).toISOString() : undefined,
            time,
          }),
      );
      return;
    }
    case 'event_msg/sub_agent_activity': {
      const id = String(payload.event_id ?? payload.agent_thread_id ?? '');
      if (!id) return;
      const known = state.bySubAgent.get(id);
      if (payload.kind === 'started' && !known) {
        const event = state.ledger.push(
          (seq) =>
            new ToolEvent({
              seq,
              time,
              call: new ToolCall({
                id: `agent:${id}`,
                name: 'sub_agent',
                kind: 'task',
                title: `Sub-agente ${basename(payload.agent_path) || ''}`.trim(),
                status: 'running',
                params: { agent_path: payload.agent_path ?? '' },
              }),
            }),
        );
        state.bySubAgent.set(id, event);
      } else if (known && payload.kind !== 'started' && known.call.status === 'running') {
        const next = state.ledger.replace(
          known,
          new ToolEvent({ ...known, call: new ToolCall({ ...known.call, status: 'ok' }) }),
        );
        state.bySubAgent.set(id, next);
      }
      return;
    }
    default:
      return;
  }
}

const consumer: Consumer<State> = {
  init: () => ({ ledger: new Ledger(), byCallId: new Map(), bySubAgent: new Map() }),
  consume,
};

// --------------------------------------------------------------- capabilities

/**
 * Codex takes slash commands, but `/model` opens a picker that wants arrow
 * keys rather than an argument, and no session on this machine shows a form
 * that sets the model in one line. So the pill shows the model the session
 * reports and sends nothing. Better a read-only pill than one that opens a
 * menu the phone cannot drive.
 */
const capabilitiesFor = (model: string | undefined): Capabilities =>
  new Capabilities({
    id: 'codex',
    label: 'Codex',
    structured: true,
    slashCommands: true,
    backgroundTasks: false,
    toolResults: true,
    diffs: true,
    fileReference: 'bare-path',
    interruptKeys: ['Escape'],
    controls: model
      ? [
          new Control({
            id: 'model',
            label: 'Modello',
            current: model,
            options: [new ControlOption({ id: model, label: model, send: '' })],
          }),
        ]
      : [],
  });

// ------------------------------------------------------------------- assembly

interface Located {
  readonly file: string;
  readonly session: string;
  readonly match: SessionMatch;
}

export const make: Effect.Effect<Adapter, never, Transcript> = Effect.gen(function* () {
  const transcript = yield* Transcript;
  const cache = new Map<string, { at: number; found: Located | null }>();
  const CACHE_TTL = 60_000;

  const locate = (pane: PaneInfo): Effect.Effect<Located | null> =>
    Effect.gen(function* () {
      const cached = cache.get(pane.paneId);
      if (cached && cached.at > Date.now()) return cached.found;

      let found: Located | null = null;
      const rollouts = yield* listRollouts;

      const id = pane.agentSession;
      if (id && /^[A-Za-z0-9-]+$/.test(id)) {
        const hit = rollouts.find((r) => r.file.endsWith(`-${id}.jsonl`));
        if (hit) found = { file: hit.file, session: id, match: 'session' };
      }

      // By directory only when the pane says it is Codex: any folder Codex
      // once worked in has a rollout, and a plain shell there is not that.
      if (!found && pane.cwd && /^codex/i.test(String(pane.agent ?? ''))) {
        const wanted = normalizeDir(pane.cwd);
        for (const rollout of rollouts.slice(0, 200)) {
          const cwd = yield* cwdOf(rollout.file);
          if (cwd && normalizeDir(cwd) === wanted) {
            const session = path.basename(rollout.file, '.jsonl').replace(/^rollout-[^-]+-[^-]+-[^-]+-/, '');
            found = { file: rollout.file, session, match: 'cwd' };
            break;
          }
        }
      }

      cache.set(pane.paneId, { at: Date.now() + CACHE_TTL, found });
      return found;
    });

  return {
    id: 'codex',
    label: 'Codex',

    detect: (pane) =>
      Effect.gen(function* () {
        const isCodex = /^codex/i.test(String(pane.agent ?? ''));
        if (!isCodex && !pane.agentSession) return false;
        const located = yield* locate(pane);
        return located !== null && (isCodex || located.match === 'session');
      }),

    capabilities: (pane) =>
      Effect.gen(function* () {
        const located = yield* locate(pane);
        if (!located) return capabilitiesFor(undefined);
        const state = yield* transcript
          .read(located.file, consumer)
          .pipe(Effect.orElseSucceed(() => undefined));
        return capabilitiesFor(state?.model);
      }),

    conversation: (pane, since) =>
      Effect.gen(function* () {
        const located = yield* locate(pane);
        if (!located) {
          return yield* new AdapterError({ adapter: 'codex', reason: 'nessuna sessione Codex per questa finestra' });
        }
        const state = yield* transcript.read(located.file, consumer).pipe(
          Effect.mapError((cause) => new AdapterError({ adapter: 'codex', reason: cause.reason })),
        );
        return new ConversationPage({
          paneId: pane.paneId,
          agent: 'codex',
          session: located.session,
          match: located.match,
          total: state.ledger.events.length,
          rev: state.ledger.revision,
          events: state.ledger.changedSince(since),
        });
      }),
  };
});
