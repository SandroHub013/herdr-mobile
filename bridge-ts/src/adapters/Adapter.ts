import { Context, Data, Effect, Layer } from 'effect';
import type { Capabilities } from '../domain/Capabilities.ts';
import type { ConversationPage } from '../domain/Event.ts';

/**
 * One agent, one adapter.
 *
 * Everything the app shows about a session comes through here. An adapter's
 * whole job is to turn what its agent leaves behind — a JSONL transcript, a
 * session log, in the worst case a terminal screen — into the same events and
 * to say honestly, through its manifest, what it could not reconstruct.
 *
 * Adding an agent means writing one of these and putting it in the registry.
 * If it means editing the app, the boundary drawn here is wrong.
 */

export interface PaneInfo {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly cwd?: string | undefined;
  /** What Herdr thinks is running: "claude", "codex". A hint, not proof. */
  readonly agent?: string | undefined;
  /** The session id the agent reported to Herdr, when it reports one. */
  readonly agentSession?: string | undefined;
  readonly terminalTitle?: string | undefined;
}

export class AdapterError extends Data.TaggedError('AdapterError')<{
  readonly adapter: string;
  readonly reason: string;
}> {}

export interface Adapter {
  readonly id: string;
  readonly label: string;
  /**
   * Whether this adapter can speak for the pane. Called in registry order, so
   * an adapter must answer only for what it can genuinely read: claiming a
   * pane and then producing nothing is worse than declining it.
   */
  readonly detect: (pane: PaneInfo) => Effect.Effect<boolean>;
  readonly capabilities: (pane: PaneInfo) => Effect.Effect<Capabilities>;
  /** Events from `after` onward; the app holds everything before it already. */
  readonly conversation: (
    pane: PaneInfo,
    after: number,
  ) => Effect.Effect<ConversationPage, AdapterError>;
}

export class Adapters extends Context.Tag('Adapters')<
  Adapters,
  {
    /** The adapter that claims this pane. Never fails: the fallback claims everything. */
    readonly forPane: (pane: PaneInfo) => Effect.Effect<Adapter>;
    readonly all: ReadonlyArray<Adapter>;
  }
>() {}

/**
 * Builds the registry. Order matters and is a real decision: the structured
 * adapters get first refusal, and the fallback — which can read any pane
 * badly — must be last, or it would swallow every session.
 */
export const layer = (
  structured: ReadonlyArray<Adapter>,
  fallback: Adapter,
): Layer.Layer<Adapters> =>
  Layer.succeed(Adapters, {
    all: [...structured, fallback],
    forPane: (pane) =>
      Effect.gen(function* () {
        for (const adapter of structured) {
          if (yield* adapter.detect(pane)) return adapter;
        }
        return fallback;
      }),
  });
