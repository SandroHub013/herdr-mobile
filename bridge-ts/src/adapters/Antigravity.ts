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
  type Diff,
  type ToolKind,
} from '../domain/Event.ts';
import { buildDiff, mergeDiffs, parseUnifiedDiff, wholeFileDiff } from '../domain/diff.ts';
import { Transcript, type Consumer } from '../services/Transcript.ts';
import { AdapterError, type Adapter, type PaneInfo } from './Adapter.ts';
import { Ledger } from './Ledger.ts';

/**
 * Antigravity CLI — what the `agy` command runs.
 *
 * It keeps a "brain" per session under ~/.gemini, and in it a transcript with
 * one step per line: the user's request, the planner's reply with the tool
 * calls it decided on, and one line per tool with what came back. Herdr
 * reports the session id for the pane, so there is nothing to guess.
 *
 * Two things are better than Claude Code's record and one is worse. An edit
 * carries the line it starts at, so the diff is numbered without searching
 * for the old text; and every call has a one-line summary written by the
 * agent itself. But a result is not tied to its call by any id — only by
 * order — so completions are matched to the oldest call still waiting.
 */

const BRAIN = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

const transcriptFor = (sessionId: string) =>
  path.join(BRAIN, sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');

const exists = (file: string) =>
  Effect.tryPromise(() => fs.access(file)).pipe(Effect.as(true), Effect.orElseSucceed(() => false));

// ------------------------------------------------------------------ describing

const basename = (value: unknown): string => {
  const text = String(value ?? '').replace(/[\\/]+$/, '');
  return path.basename(text) || text;
};

/** The file a call is about, under whichever name this tool uses for it. */
const fileOf = (args: Record<string, unknown>): string | undefined => {
  for (const key of ['TargetFile', 'AbsolutePath', 'DirectoryPath', 'FilePath', 'Path']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
};

function describeTool(
  name: string,
  args: Record<string, unknown>,
): { kind: ToolKind; title: string; path?: string } {
  const file = fileOf(args);
  // The agent writes a summary for every call; it is its own words and it is
  // short, so it beats anything assembled here.
  const summary = typeof args.toolSummary === 'string' ? args.toolSummary.trim() : '';
  const kind: ToolKind = (() => {
    switch (name) {
      case 'view_file':
      case 'view_code_item':
        return 'read';
      case 'replace_file_content':
      case 'multi_replace_file_content':
        return 'edit';
      case 'write_to_file':
        return 'write';
      case 'run_command':
      case 'command_status':
        return 'shell';
      case 'grep_search':
      case 'find_by_name':
      case 'list_dir':
        return 'search';
      case 'search_web':
      case 'read_url_content':
        return 'web';
      case 'invoke_subagent':
      case 'define_subagent':
      case 'manage_subagents':
        return 'task';
      default:
        return 'other';
    }
  })();

  const fallback = (() => {
    switch (kind) {
      case 'read':
        return `Letto ${basename(file)}`;
      case 'edit':
        return `Modificato ${basename(file)}`;
      case 'write':
        return `Scritto ${basename(file)}`;
      case 'shell':
        return String(args.CommandLine ?? args.Command ?? name).slice(0, 80);
      case 'search':
        return `Cercato ${String(args.Query ?? args.Pattern ?? args.SearchDirectory ?? file ?? '')}`.slice(0, 100);
      case 'web':
        return `${name === 'search_web' ? 'Cercato sul web' : 'Aperto'} ${String(args.query ?? args.Url ?? '')}`.slice(0, 100);
      default:
        return name.replace(/_/g, ' ');
    }
  })();

  return { kind, title: summary || fallback, path: file };
}

/** The diff an edit already contains: this agent records both sides and the line. */
function diffFor(name: string, args: Record<string, unknown>): Diff | undefined {
  const file = fileOf(args);
  if (!file) return undefined;

  if (name === 'replace_file_content' && typeof args.TargetContent === 'string') {
    return buildDiff({
      path: file,
      before: args.TargetContent,
      after: String(args.ReplacementContent ?? ''),
      startLine: Number(args.StartLine) || undefined,
    });
  }
  if (name === 'multi_replace_file_content' && Array.isArray(args.ReplacementChunks)) {
    const parts = (args.ReplacementChunks as Array<Record<string, unknown>>)
      .filter((chunk) => typeof chunk?.TargetContent === 'string')
      .map((chunk) =>
        buildDiff({
          path: file,
          before: String(chunk.TargetContent),
          after: String(chunk.ReplacementContent ?? ''),
          startLine: Number(chunk.StartLine) || undefined,
        }),
      );
    return parts.length > 0 ? mergeDiffs(file, parts) : undefined;
  }
  if (name === 'write_to_file' && typeof args.CodeContent === 'string') {
    return wholeFileDiff(file, args.CodeContent);
  }
  return undefined;
}

// -------------------------------------------------------------------- parsing

interface State {
  ledger: Ledger;
  /** Calls without a result yet, oldest first: results arrive in this order and carry no id. */
  pending: ToolEvent[];
  /** A step that reported RUNNING and then DONE is one call, not two. */
  byStep: Map<number, ToolEvent>;
  model?: string;
}

const USER_REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;
const MODEL_CHANGE = /changed setting `Model Selection` from .*? to ([^.\n]+?)\.?(?:\s|$)/;
/** Anything the runtime wraps around the user's words, for the lines that have no USER_REQUEST tag. */
const RUNTIME_TAGS = /<\/?(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE)[^>]*>[\s\S]*?(?=<|$)/g;

/**
 * A result names the tool it came from — "changes were made by the
 * replace_file_content tool to: C:\..." — which is what makes the pairing
 * exact rather than positional.
 */
const RESULT_TOOL = /\bby the (\w+) tool\b/;
/** And for an edit it carries the patch that actually landed, with the file's own numbering. */
const DIFF_BLOCK = /\[diff_block_start\]\n([\s\S]*?)\[diff_block_end\]/;
/** The two timestamps every result opens with; the output proper starts after them. */
const RESULT_HEADER = /^(?:Created At: .*\n)?(?:Completed At: .*\n)?/;

/** Step types that are a tool's result rather than something the planner said. */
const RESULT_TYPES = new Set([
  'GENERIC',
  'RUN_COMMAND',
  'VIEW_FILE',
  'CODE_ACTION',
  'LIST_DIRECTORY',
  'GREP_SEARCH',
  'FIND_BY_NAME',
  'SEARCH_WEB',
  'GENERATE_IMAGE',
  'READ_URL_CONTENT',
  'ASK_QUESTION',
  'COMMAND_STATUS',
]);

/** The call a result belongs to: the one it names, or failing that the oldest waiting. */
function take(state: State, toolName: string | undefined): ToolEvent | undefined {
  if (toolName) {
    const at = state.pending.findIndex((event) => event.call.name === toolName);
    if (at !== -1) return state.pending.splice(at, 1)[0];
  }
  return state.pending.shift();
}

/** Closes whatever is still waiting, without claiming to know how it went. */
function settlePending(state: State): void {
  for (const event of state.pending) {
    state.ledger.replace(
      event,
      new ToolEvent({ ...event, call: new ToolCall({ ...event.call, status: 'ok' }) }),
    );
  }
  state.pending.length = 0;
}

function consume(state: State, line: string): void {
  if (!line.includes('"type":"')) return;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const time = typeof entry.created_at === 'string' ? entry.created_at : undefined;
  const type = String(entry.type ?? '');

  if (type === 'USER_INPUT') {
    const raw = String(entry.content ?? '');
    const settings = MODEL_CHANGE.exec(raw);
    if (settings) state.model = settings[1].trim();
    const request = USER_REQUEST.exec(raw);
    const text = (request ? request[1] : raw.replace(RUNTIME_TAGS, '')).trim();
    if (!text) return;
    state.ledger.push((seq) => new MessageEvent({ seq, role: 'user', text, time }));
    return;
  }

  if (type === 'PLANNER_RESPONSE') {
    // The planner only speaks again once its tools have returned, so anything
    // still pending when this line arrives did finish — its result just was
    // not written down. Closing them here keeps one silent tool from shifting
    // every later result onto the wrong call.
    settlePending(state);
    const text = String(entry.content ?? '').trim();
    if (text) state.ledger.push((seq) => new MessageEvent({ seq, role: 'assistant', text, time }));
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const name = String(call.name ?? '');
        const args = (call.args ?? {}) as Record<string, unknown>;
        const described = describeTool(name, args);
        const event = state.ledger.push(
          (seq) =>
            new ToolEvent({
              seq,
              time,
              call: new ToolCall({
                id: `${seq}`,
                name,
                kind: described.kind,
                title: described.title,
                status: 'running',
                params: args,
                path: described.path,
                diff: diffFor(name, args),
              }),
            }),
        );
        state.pending.push(event);
      }
    }
    return;
  }

  if (entry.source === 'MODEL' && RESULT_TYPES.has(type)) {
    const step = Number(entry.step_index);
    const output = String(entry.content ?? '');
    let event = state.byStep.get(step);
    if (!event) {
      event = take(state, RESULT_TOOL.exec(output)?.[1]);
      if (!event) return;
      state.byStep.set(step, event);
    }
    const done = entry.status === 'DONE';
    const body = output.replace(RESULT_HEADER, '');
    const failed = done && /^(error|traceback|command failed|exit code [1-9])/im.test(body);
    // The patch in the result beats the one worked out from the arguments: it
    // is what landed, numbered by the file rather than by a search for the old
    // text.
    const patch = event.call.path ? DIFF_BLOCK.exec(body)?.[1] : undefined;
    const next = state.ledger.replace(
      event,
      new ToolEvent({
        ...event,
        call: new ToolCall({
          ...event.call,
          status: done ? (failed ? 'error' : 'ok') : 'running',
          error: failed ? body.slice(0, 300) : undefined,
          diff: patch ? parseUnifiedDiff(event.call.path!, patch) : event.call.diff,
        }),
      }),
    );
    state.byStep.set(step, next);
    return;
  }

  if (type === 'ERROR_MESSAGE') {
    const text = String(entry.content ?? '').trim().slice(0, 300);
    if (text) state.ledger.push((seq) => new NoticeEvent({ seq, kind: 'error', text, time }));
    return;
  }

  if (type === 'CONVERSATION_HISTORY') {
    state.ledger.push(
      (seq) =>
        new NoticeEvent({
          seq,
          kind: 'compaction',
          text: "Contesto riassunto: da qui l'agente ricorda solo un riepilogo.",
          time,
        }),
    );
  }
}

const consumer: Consumer<State> = {
  init: () => ({ ledger: new Ledger(), pending: [], byStep: new Map() }),
  consume,
};

// --------------------------------------------------------------- capabilities

/**
 * No control here sends anything. The model is picked in Antigravity's own
 * settings, and no slash command to change it has been seen in a session on
 * this machine — so the pill shows what the agent reported and takes no
 * orders, rather than typing a command that does not exist.
 */
const capabilitiesFor = (model: string | undefined): Capabilities =>
  new Capabilities({
    id: 'antigravity',
    label: 'Antigravity',
    structured: true,
    slashCommands: false,
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

export const make: Effect.Effect<Adapter, never, Transcript> = Effect.gen(function* () {
  const transcript = yield* Transcript;

  /** The session file behind a pane. Only Herdr's report counts: the brain is keyed by id, never by directory. */
  const locate = (pane: PaneInfo) =>
    Effect.gen(function* () {
      const id = pane.agentSession;
      if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return null;
      const file = transcriptFor(id);
      return (yield* exists(file)) ? { file, session: id } : null;
    });

  const isAgy = (pane: PaneInfo) => /^(agy|antigravity)/i.test(String(pane.agent ?? ''));

  return {
    id: 'antigravity',
    label: 'Antigravity',

    detect: (pane) =>
      Effect.gen(function* () {
        if (!isAgy(pane)) return false;
        return (yield* locate(pane)) !== null;
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
          return yield* new AdapterError({
            adapter: 'antigravity',
            reason: 'nessuna sessione Antigravity per questa finestra',
          });
        }
        const state = yield* transcript.read(located.file, consumer).pipe(
          Effect.mapError((cause) => new AdapterError({ adapter: 'antigravity', reason: cause.reason })),
        );
        return new ConversationPage({
          paneId: pane.paneId,
          agent: 'antigravity',
          session: located.session,
          match: 'session',
          total: state.ledger.events.length,
          rev: state.ledger.revision,
          events: state.ledger.changedSince(since),
        });
      }),
  };
});
