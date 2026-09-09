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
} from '../domain/Event.ts';
import { Transcript, type Consumer } from '../services/Transcript.ts';
import { AdapterError, type Adapter, type PaneInfo } from './Adapter.ts';
import { Ledger } from './Ledger.ts';

/**
 * PrimeAgent — the agent Herdr knows as `pi`.
 *
 * Its record is the tidiest of the lot: one JSON line per event, the file
 * named after the session, messages already split into text, thinking and
 * tool calls, and every result carrying the id of the call it answers.
 *
 * What makes it different from the others is that it has exactly one tool: a
 * live Python kernel. It reads files, writes them, runs commands and searches
 * by writing code, so there is nothing to classify and no diff to show — the
 * manifest says so rather than letting the app promise a diff view that would
 * always be empty.
 */

/** Where the sessions live. `.prime` is this build's name for it, `.piagent` upstream's. */
const SESSION_DIRS = [
  process.env.PI_CONFIG_DIR ? path.join(process.env.PI_CONFIG_DIR, 'agent', 'sessions') : undefined,
  path.join(os.homedir(), '.prime', 'agent', 'sessions'),
  path.join(os.homedir(), '.piagent', 'agent', 'sessions'),
].filter((dir): dir is string => typeof dir === 'string');

const stat = (file: string) =>
  Effect.tryPromise(() => fs.stat(file)).pipe(Effect.orElseSucceed(() => null));

// ------------------------------------------------------------------ describing

/**
 * A one-line name for a block of Python.
 *
 * The first line that does something: imports and comments are scaffolding,
 * and a card that says "import os" tells the reader nothing about the step.
 */
function titleOf(code: string): string {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  let fallback = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Scaffolding that says nothing about the step: an import, a bare `try:`,
    // the magic that turns the cell into a shell. The line after it is the
    // one worth showing.
    if (/^(import |from \w[\w.]* import |%%\w+$|try:$|else:$|finally:$)/.test(line)) {
      fallback ||= line;
      continue;
    }
    return line.slice(0, 100);
  }
  return (fallback || 'codice Python').slice(0, 100);
}

// -------------------------------------------------------------------- parsing

interface State {
  ledger: Ledger;
  byCallId: Map<string, ToolEvent>;
  cwd?: string;
  model?: string;
  thinking?: string;
}

/** The text of a message, ignoring the thinking the reader did not ask for. */
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
    .trim();
};

function consume(state: State, line: string): void {
  if (!line.includes('"type":"')) return;
  // Most of a session's lines are status heartbeats. Parsing them all is what
  // makes a 15MB transcript slow, and none of them reach the reader.
  const head = line.slice(0, 120);
  if (head.includes('"type":"agent_status"') || head.includes('"type":"git_state"')) return;

  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const time = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

  switch (entry.type) {
    case 'session': {
      if (typeof entry.cwd === 'string') state.cwd = entry.cwd;
      return;
    }
    case 'model_change': {
      if (typeof entry.modelId === 'string') state.model = entry.modelId;
      return;
    }
    case 'thinking_level_change': {
      if (typeof entry.thinkingLevel === 'string') state.thinking = entry.thinkingLevel;
      return;
    }
    case 'custom_message': {
      if (entry.customType === 'ipython_state_restored') {
        state.ledger.push(
          (seq) =>
            new NoticeEvent({
              seq,
              kind: 'compaction',
              text: 'Kernel Python ripreso dalla sessione precedente.',
              time,
            }),
        );
      }
      return;
    }
    case 'message':
      break;
    default:
      return;
  }

  const message = entry.message ?? {};
  const role = String(message.role ?? '');

  if (role === 'user') {
    const text = textOf(message.content);
    if (text) state.ledger.push((seq) => new MessageEvent({ seq, role: 'user', text, time }));
    return;
  }

  if (role === 'assistant') {
    const text = textOf(message.content);
    if (text) state.ledger.push((seq) => new MessageEvent({ seq, role: 'assistant', text, time }));
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block?.type !== 'toolCall') continue;
      const args = (block.arguments ?? {}) as Record<string, unknown>;
      const code = typeof args.code === 'string' ? args.code : '';
      const id = String(block.id ?? '');
      const event = state.ledger.push(
        (seq) =>
          new ToolEvent({
            seq,
            time,
            call: new ToolCall({
              id: id || `${seq}`,
              name: String(block.name ?? 'ipython'),
              kind: 'shell',
              title: code ? titleOf(code) : String(block.name ?? 'ipython'),
              status: 'running',
              params: args,
            }),
          }),
      );
      state.byCallId.set(event.call.id, event);
    }
    return;
  }

  if (role === 'toolResult') {
    const event = state.byCallId.get(String(message.toolCallId ?? ''));
    if (!event) return;
    const failed = message.isError === true || message.details?.status === 'error';
    const stderr = String(message.details?.stderr ?? '') || textOf(message.content);
    const next = state.ledger.replace(
      event,
      new ToolEvent({
        ...event,
        call: new ToolCall({
          ...event.call,
          status: failed ? 'error' : 'ok',
          error: failed ? stderr.slice(0, 300) : undefined,
        }),
      }),
    );
    state.byCallId.set(next.call.id, next);
  }
}

const consumer: Consumer<State> = {
  init: () => ({ ledger: new Ledger(), byCallId: new Map() }),
  consume,
};

// --------------------------------------------------------------- capabilities

/**
 * Read-only pills. PrimeAgent's model and thinking level are set from its own
 * picker, not by a line of text, so these report the state and send nothing.
 */
const capabilitiesFor = (state: { model?: string; thinking?: string }): Capabilities => {
  const readOnly = (id: string, label: string, current: string | undefined) =>
    current
      ? [
          new Control({
            id,
            label,
            current,
            options: [new ControlOption({ id: current, label: current, send: '' })],
          }),
        ]
      : [];

  return new Capabilities({
    id: 'prime',
    label: 'PrimeAgent',
    structured: true,
    slashCommands: false,
    backgroundTasks: false,
    toolResults: true,
    // Everything goes through a Python kernel: there is no edit tool to diff.
    diffs: false,
    fileReference: 'bare-path',
    interruptKeys: ['Escape'],
    controls: [...readOnly('model', 'Modello', state.model), ...readOnly('thinking', 'Ragionamento', state.thinking)],
  });
};

// ------------------------------------------------------------------- assembly

interface Located {
  readonly file: string;
  readonly session: string;
  readonly match: SessionMatch;
}

const normalizeDir = (dir: string) => path.resolve(dir).replace(/[\\/]+$/, '').toLowerCase();

/** The directory a session was started in, from its first line. */
const cwdOf = (file: string) =>
  Effect.tryPromise(async () => {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(2048);
      const { bytesRead } = await handle.read(buffer, 0, 2048, 0);
      const head = buffer.toString('utf8', 0, bytesRead);
      const end = head.indexOf('\n');
      const meta = JSON.parse(end === -1 ? head : head.slice(0, end)) as { cwd?: string };
      return typeof meta.cwd === 'string' ? meta.cwd : null;
    } finally {
      await handle.close();
    }
  }).pipe(Effect.orElseSucceed(() => null));

export const make: Effect.Effect<Adapter, never, Transcript> = Effect.gen(function* () {
  const transcript = yield* Transcript;
  const cache = new Map<string, { at: number; found: Located | null }>();
  const CACHE_TTL = 60_000;

  const isPrime = (pane: PaneInfo) => /^(pi|prime)/i.test(String(pane.agent ?? ''));

  const locate = (pane: PaneInfo): Effect.Effect<Located | null> =>
    Effect.gen(function* () {
      const cached = cache.get(pane.paneId);
      if (cached && cached.at > Date.now()) return cached.found;

      let found: Located | null = null;

      // By id: the file is named after the session, so this is one stat call.
      const id = pane.agentSession;
      if (id && /^[A-Za-z0-9-]+$/.test(id)) {
        for (const dir of SESSION_DIRS) {
          const file = path.join(dir, `${id}.jsonl`);
          if (yield* stat(file)) {
            found = { file, session: id, match: 'session' };
            break;
          }
        }
      }

      // By directory, newest first — only for a pane Herdr says is PrimeAgent.
      if (!found && pane.cwd && isPrime(pane)) {
        const wanted = normalizeDir(pane.cwd);
        const files = yield* Effect.tryPromise(async () => {
          const all: Array<{ file: string; mtime: number }> = [];
          for (const dir of SESSION_DIRS) {
            for (const name of await fs.readdir(dir).catch(() => [])) {
              if (!name.endsWith('.jsonl')) continue;
              const file = path.join(dir, name);
              const info = await fs.stat(file).catch(() => null);
              if (info) all.push({ file, mtime: info.mtimeMs });
            }
          }
          return all.sort((a, b) => b.mtime - a.mtime).slice(0, 80);
        }).pipe(Effect.orElseSucceed(() => [] as Array<{ file: string; mtime: number }>));

        for (const candidate of files) {
          const cwd = yield* cwdOf(candidate.file);
          if (cwd && normalizeDir(cwd) === wanted) {
            found = {
              file: candidate.file,
              session: path.basename(candidate.file, '.jsonl'),
              match: 'cwd',
            };
            break;
          }
        }
      }

      cache.set(pane.paneId, { at: Date.now() + CACHE_TTL, found });
      return found;
    });

  return {
    id: 'prime',
    label: 'PrimeAgent',

    detect: (pane) =>
      Effect.gen(function* () {
        if (!isPrime(pane)) return false;
        return (yield* locate(pane)) !== null;
      }),

    capabilities: (pane) =>
      Effect.gen(function* () {
        const located = yield* locate(pane);
        if (!located) return capabilitiesFor({});
        const state = yield* transcript
          .read(located.file, consumer)
          .pipe(Effect.orElseSucceed(() => undefined));
        return capabilitiesFor(state ?? {});
      }),

    conversation: (pane, since) =>
      Effect.gen(function* () {
        const located = yield* locate(pane);
        if (!located) {
          return yield* new AdapterError({ adapter: 'prime', reason: 'nessuna sessione PrimeAgent per questa finestra' });
        }
        const state = yield* transcript.read(located.file, consumer).pipe(
          Effect.mapError((cause) => new AdapterError({ adapter: 'prime', reason: cause.reason })),
        );
        return new ConversationPage({
          paneId: pane.paneId,
          agent: 'prime',
          session: located.session,
          match: located.match,
          total: state.ledger.events.length,
          rev: state.ledger.revision,
          events: state.ledger.changedSince(since),
        });
      }),
  };
});
