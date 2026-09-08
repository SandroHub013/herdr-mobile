import { Schema } from 'effect';

/**
 * What the phone reads: one conversation, whichever agent is holding it.
 *
 * Every adapter turns its agent's own record — Claude Code's JSONL, Codex's
 * session file, a plain terminal's scrollback — into these events, and the app
 * knows nothing else. Adding an agent must never mean touching the app; when
 * it does, the fault is here.
 *
 * The rule that keeps this honest: an event carries *what happened*, never how
 * to draw it. `title` is the one exception, because only the adapter knows
 * that `Bash` with a `description` reads better as the description.
 */

// ---------------------------------------------------------------- tool calls

/**
 * What a tool did, in the few kinds the app draws differently. The agent's own
 * name for it stays in `name`; this is only the shape of the card.
 */
export const ToolKind = Schema.Literal(
  'read', // opened a file
  'edit', // changed a file — the only kind that carries a diff
  'write', // created a file
  'shell', // ran a command
  'search', // grep, glob, a codebase question
  'web', // fetched or searched the web
  'task', // handed work to a sub-agent
  'other',
);
export type ToolKind = typeof ToolKind.Type;

export const ToolStatus = Schema.Literal('running', 'ok', 'error');
export type ToolStatus = typeof ToolStatus.Type;

/** One run of changed lines, with the file's own numbering where we could recover it. */
export class DiffHunk extends Schema.Class<DiffHunk>('DiffHunk')({
  /**
   * First line of the hunk in the file. Falls back to 1 when the old text
   * could not be found in the file as it stands — the change is still right,
   * only its position is relative. Roughly a third of edits land that way.
   */
  startLine: Schema.Number,
  lines: Schema.Array(
    Schema.Struct({
      kind: Schema.Literal('context', 'added', 'removed'),
      text: Schema.String,
    }),
  ),
}) {}

export class Diff extends Schema.Class<Diff>('Diff')({
  path: Schema.String,
  added: Schema.Number,
  removed: Schema.Number,
  hunks: Schema.Array(DiffHunk),
  /**
   * Set when the edit was too large to send whole. The app shows the counts
   * and offers the file, rather than pretending it has the change.
   */
  truncated: Schema.Boolean,
}) {}

/**
 * Work the agent left running while it carried on talking.
 *
 * Not every agent has the idea. Those that do report it differently, so the
 * adapter fills this in and the app just renders a list with timers.
 */
export class BackgroundRun extends Schema.Class<BackgroundRun>('BackgroundRun')({
  id: Schema.String,
  startedAt: Schema.String,
  /** Absent while it is still going: that is what makes the timer live. */
  endedAt: Schema.optional(Schema.String),
}) {}

export class ToolCall extends Schema.Class<ToolCall>('ToolCall')({
  /** The agent's own id for the call, so a later result can find it. */
  id: Schema.String,
  /** What the agent calls it: `Edit`, `apply_patch`, `shell`. Shown in the detail sheet. */
  name: Schema.String,
  kind: ToolKind,
  /** One line, already in the reader's language: "Modificato ansi.ts". */
  title: Schema.String,
  status: ToolStatus,
  /** The call's own arguments, for the sheet that shows what was actually run. */
  params: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  /** The file this touched, when it touched one. Makes the card tappable. */
  path: Schema.optional(Schema.String),
  diff: Schema.optional(Diff),
  background: Schema.optional(BackgroundRun),
  /** Short, for a failure the reader should see without opening anything. */
  error: Schema.optional(Schema.String),
}) {}

// -------------------------------------------------------------------- events

export class MessageEvent extends Schema.TaggedClass<MessageEvent>()('Message', {
  seq: Schema.Number,
  role: Schema.Literal('user', 'assistant'),
  /** Markdown. The app renders it; it is not stripped on the way out. */
  text: Schema.String,
  /** Pictures the reader sent with it. The transcript keeps bytes, not names. */
  images: Schema.optional(Schema.Number),
  time: Schema.optional(Schema.String),
}) {}

export class ToolEvent extends Schema.TaggedClass<ToolEvent>()('Tool', {
  seq: Schema.Number,
  call: ToolCall,
  time: Schema.optional(Schema.String),
}) {}

/**
 * Something that happened to the session rather than in the conversation: the
 * context was compacted, the usage limit is close, the agent was interrupted.
 */
export class NoticeEvent extends Schema.TaggedClass<NoticeEvent>()('Notice', {
  seq: Schema.Number,
  kind: Schema.Literal('compaction', 'limit', 'interrupted', 'error'),
  text: Schema.String,
  /** For a limit: when it lifts. */
  resetsAt: Schema.optional(Schema.String),
  time: Schema.optional(Schema.String),
}) {}

export const AgentEvent = Schema.Union(MessageEvent, ToolEvent, NoticeEvent);
export type AgentEvent = typeof AgentEvent.Type;

// --------------------------------------------------------------------- pages

/** How the adapter found the session behind a pane. Shown when it had to guess. */
export const SessionMatch = Schema.Literal('session', 'process', 'cwd', 'screen');
export type SessionMatch = typeof SessionMatch.Type;

export class ConversationPage extends Schema.Class<ConversationPage>('ConversationPage')({
  paneId: Schema.String,
  /** Which adapter produced this: `claude-code`, `codex`, `terminal`. */
  agent: Schema.String,
  session: Schema.NullOr(Schema.String),
  match: SessionMatch,
  /** Everything the adapter has, whether or not it was sent this time. */
  total: Schema.Number,
  /**
   * Where the conversation has got to. The app sends this back as `since` and
   * receives whatever changed after it.
   *
   * Paging by index would be simpler and wrong: events are not only appended,
   * they are amended. A tool call is written the moment it starts and rewritten
   * when its result lands; a background run started before lunch is closed
   * after it. Asking for "everything past number 400" would never mention
   * number 12 again, and the app would show a task that finished an hour ago
   * as still running.
   */
  rev: Schema.Number,
  events: Schema.Array(AgentEvent),
}) {}
