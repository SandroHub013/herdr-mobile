import { Schema } from 'effect';

/**
 * What the agent in a pane can actually be asked to do.
 *
 * The app has one screen for every agent, and this is what stops that screen
 * from being a lie. Claude Code has effort levels; Codex does not. Some agents
 * take slash commands, some take none. The app renders the controls this
 * manifest declares and nothing else.
 *
 * The constraint that shapes the whole file: the bridge has exactly one way to
 * reach an agent — typing into its terminal. So a control cannot merely say
 * *that* a setting exists, it has to carry the keystrokes that change it. An
 * option without a `send` is a button that does nothing.
 */

/** Keys as Herdr names them, for the things that are not text: Escape, C-c. */
export const KeyStroke = Schema.String;

export class ControlOption extends Schema.Class<ControlOption>('ControlOption')({
  id: Schema.String,
  label: Schema.String,
  /** "Predefinito", "Consuma i limiti più in fretta" — the small print under the row. */
  note: Schema.optional(Schema.String),
  /**
   * Literally what gets typed into the pane to pick this. `\r` submits.
   * Empty means the option is a label only, and the app shows it disabled.
   */
  send: Schema.String,
}) {}

export class Control extends Schema.Class<Control>('Control')({
  /** `model`, `effort`, `permission` — the app styles the known ones. */
  id: Schema.String,
  label: Schema.String,
  /** Shown on the composer pill when nothing is selected yet. */
  placeholder: Schema.optional(Schema.String),
  options: Schema.Array(ControlOption),
  /**
   * The option the agent last reported, when the adapter can tell. The pill
   * shows it; if it is absent the pill shows the placeholder and the app never
   * pretends to know.
   */
  current: Schema.optional(Schema.String),
}) {}

export class Capabilities extends Schema.Class<Capabilities>('Capabilities')({
  /** `claude-code`, `codex`, `nikcli`, `terminal`. */
  id: Schema.String,
  /** "Claude Code" — what the header shows under the session name. */
  label: Schema.String,

  /**
   * The adapter reconstructs a real conversation from the agent's own record.
   * False means the fallback is in play: text on a screen, no tool cards, no
   * diffs. The app hides what it cannot honestly draw.
   */
  structured: Schema.Boolean,

  /** Typing `/` offers the agent's commands. */
  slashCommands: Schema.Boolean,
  /** The agent reports work left running; the background sheet is worth showing. */
  backgroundTasks: Schema.Boolean,
  /** Tool calls carry results, so cards can say Completato / Fallito. */
  toolResults: Schema.Boolean,
  /** Edits carry a diff the viewer can open. */
  diffs: Schema.Boolean,

  /** Model pill, effort sheet, permission row — whatever this agent really has. */
  controls: Schema.Array(Control),

  /**
   * How a file already on the PC is named to this agent in a prompt. Claude
   * Code reads `@path`; a shell wants the bare path. Used after an upload.
   */
  fileReference: Schema.Literal('at-path', 'bare-path'),

  /** What stops it. Sent in order until the agent goes idle. */
  interruptKeys: Schema.Array(KeyStroke),
}) {}

/**
 * The manifest for a pane, with the identity of what is running in it.
 */
export class AgentInfo extends Schema.Class<AgentInfo>('AgentInfo')({
  paneId: Schema.String,
  capabilities: Capabilities,
  /** The session the adapter matched, so the app can show which one it is reading. */
  session: Schema.NullOr(Schema.String),
}) {}
