/**
 * The conversation, as the bridge hands it over.
 *
 * These mirror bridge-ts/src/domain/Event.ts exactly. They are written by hand
 * rather than generated because the app has to survive a bridge that is one
 * release behind: every field the app depends on is either required on both
 * sides or read defensively here.
 *
 * The app knows nothing about which agent produced any of it. That is the
 * whole point of the shape.
 */

export type ToolKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'shell'
  | 'search'
  | 'web'
  | 'task'
  | 'other';

export type ToolStatus = 'running' | 'ok' | 'error';

export interface DiffLine {
  readonly kind: 'context' | 'added' | 'removed';
  readonly text: string;
}

export interface DiffHunk {
  readonly startLine: number;
  readonly lines: readonly DiffLine[];
}

export interface Diff {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
  /** The change was too large to send whole: counts only, no body. */
  readonly truncated: boolean;
}

export interface BackgroundRun {
  readonly id: string;
  readonly startedAt: string;
  /** Absent while it is still going: that is what makes the timer live. */
  readonly endedAt?: string;
}

export interface ToolCall {
  readonly id: string;
  /** The agent's own name for it: `Edit`, `apply_patch`, `shell`. */
  readonly name: string;
  readonly kind: ToolKind;
  /** One line, already in the reader's language. */
  readonly title: string;
  readonly status: ToolStatus;
  readonly params: Readonly<Record<string, unknown>>;
  readonly path?: string;
  readonly diff?: Diff;
  readonly background?: BackgroundRun;
  readonly error?: string;
}

export interface MessageEvent {
  readonly _tag: 'Message';
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  /** Markdown. Rendered, not stripped. */
  readonly text: string;
  readonly images?: number;
  readonly time?: string;
}

export interface ToolEvent {
  readonly _tag: 'Tool';
  readonly seq: number;
  readonly call: ToolCall;
  readonly time?: string;
}

export interface NoticeEvent {
  readonly _tag: 'Notice';
  readonly seq: number;
  readonly kind: 'compaction' | 'limit' | 'interrupted' | 'error';
  readonly text: string;
  readonly resetsAt?: string;
  readonly time?: string;
}

export type AgentEvent = MessageEvent | ToolEvent | NoticeEvent;

export type SessionMatch = 'session' | 'process' | 'cwd' | 'screen';

export interface ConversationPage {
  readonly paneId: string;
  readonly agent: string;
  readonly session: string | null;
  readonly match: SessionMatch;
  /** Everything the bridge has, whether or not it was sent this time. */
  readonly total: number;
  /**
   * Where the conversation has got to. Sent back as `since` to get only what
   * changed — which includes events already held that have since been amended,
   * such as a tool call that has finished or a background run that has closed.
   */
  readonly rev: number;
  readonly events: readonly AgentEvent[];
}

// ------------------------------------------------------------- capabilities

export interface ControlOption {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
  /** Literally what gets typed into the pane. Empty means the app shows it disabled. */
  readonly send: string;
}

export interface Control {
  readonly id: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly options: readonly ControlOption[];
  readonly current?: string;
}

export interface Capabilities {
  readonly id: string;
  readonly label: string;
  /** False means a screen, not a conversation: the app hides what it cannot draw. */
  readonly structured: boolean;
  readonly slashCommands: boolean;
  readonly backgroundTasks: boolean;
  readonly toolResults: boolean;
  readonly diffs: boolean;
  readonly controls: readonly Control[];
  readonly fileReference: 'at-path' | 'bare-path';
  readonly interruptKeys: readonly string[];
}

export interface AgentInfo {
  readonly paneId: string;
  readonly capabilities: Capabilities;
  readonly session: string | null;
}

// ------------------------------------------------------------------ grouping

/**
 * What the feed actually draws. Consecutive tool calls collapse into one row,
 * the way the desktop shows them: a reader scrolling back wants the shape of
 * what happened, not forty lines of `Letto …`.
 */
export type Block =
  | { readonly kind: 'message'; readonly event: MessageEvent }
  | { readonly kind: 'notice'; readonly event: NoticeEvent }
  | { readonly kind: 'tools'; readonly seq: number; readonly calls: readonly ToolCall[] };

export function toBlocks(events: readonly AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  for (const event of events) {
    if (event._tag === 'Tool') {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'tools') {
        (last.calls as ToolCall[]).push(event.call);
      } else {
        blocks.push({ kind: 'tools', seq: event.seq, calls: [event.call] });
      }
      continue;
    }
    blocks.push(
      event._tag === 'Message'
        ? { kind: 'message', event }
        : { kind: 'notice', event },
    );
  }
  return blocks;
}

/** "Cercato nel codice, utilizzati 4 strumenti" */
export function describeCalls(calls: readonly ToolCall[]): string {
  if (calls.length === 1) return calls[0].title;
  const lead = calls[0].title;
  const rest = calls.length - 1;
  return `${lead}, ${rest === 1 ? 'e un altro strumento' : `e altri ${rest} strumenti`}`;
}

/** The lines added and removed across a run, for the badge on the collapsed row. */
export function countLines(calls: readonly ToolCall[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const call of calls) {
    if (!call.diff) continue;
    added += call.diff.added;
    removed += call.diff.removed;
  }
  return { added, removed };
}

/** Runs still going, newest first: what the background sheet lists at the top. */
export function runningInBackground(events: readonly AgentEvent[]): ToolCall[] {
  return events
    .filter((e): e is ToolEvent => e._tag === 'Tool')
    .map((e) => e.call)
    .filter((call) => call.background !== undefined);
}
