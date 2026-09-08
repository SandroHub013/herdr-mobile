import fs from 'node:fs/promises';
import path from 'node:path';
import { Context, Duration, Effect, Layer, PubSub, Ref, Schedule, Stream } from 'effect';
import type { PaneInfo } from '../adapters/Adapter.ts';
import { HerdrRpc } from './HerdrRpc.ts';

/**
 * What Herdr currently has open, kept fresh in the background.
 *
 * The phone must not wait on a pipe call to draw its list of workspaces, and
 * twenty phones must not each start their own poll. One loop asks Herdr, and
 * everyone reads the answer it left behind.
 */

export interface Snapshot {
  readonly workspaces: ReadonlyArray<Record<string, unknown>>;
  readonly tabs: ReadonlyArray<Record<string, unknown>>;
  readonly panes: ReadonlyArray<Record<string, unknown>>;
}

const EMPTY: Snapshot = { workspaces: [], tabs: [], panes: [] };

/** The branch a directory is on, read from .git rather than by running git. */
const gitBranch = (cwd: string | undefined) =>
  Effect.tryPromise(async () => {
    if (!cwd) return null;
    let gitDir = path.join(cwd, '.git');
    const stat = await fs.stat(gitDir);
    // A worktree's .git is a file pointing at the real directory.
    if (stat.isFile()) {
      const pointer = (await fs.readFile(gitDir, 'utf8')).trim();
      if (!pointer.startsWith('gitdir:')) return null;
      gitDir = pointer.slice('gitdir:'.length).trim();
    }
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    return head.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : head.slice(0, 7);
  }).pipe(Effect.orElseSucceed(() => null));

export class Snapshots extends Context.Tag('Snapshots')<
  Snapshots,
  {
    readonly current: Effect.Effect<Snapshot>;
    readonly pane: (paneId: string) => Effect.Effect<PaneInfo | null>;
    /** Every new snapshot, for sockets that want to be told rather than ask. */
    readonly changes: Stream.Stream<Snapshot>;
  }
>() {}

/** Herdr's pane records, in the shape the adapters were written against. */
const toPaneInfo = (pane: Record<string, any>): PaneInfo => ({
  paneId: String(pane.pane_id ?? ''),
  workspaceId: String(pane.workspace_id ?? ''),
  cwd: typeof pane.cwd === 'string' ? pane.cwd : undefined,
  agent: typeof pane.agent === 'string' ? pane.agent : undefined,
  agentSession:
    typeof pane.agent_session?.value === 'string' ? pane.agent_session.value : undefined,
  terminalTitle:
    typeof pane.terminal_title_stripped === 'string'
      ? pane.terminal_title_stripped
      : typeof pane.terminal_title === 'string'
        ? pane.terminal_title
        : undefined,
});

export const layer: Layer.Layer<Snapshots, never, HerdrRpc> = Layer.scoped(
  Snapshots,
  Effect.gen(function* () {
    const rpc = yield* HerdrRpc;
    const held = yield* Ref.make<Snapshot>(EMPTY);
    const hub = yield* PubSub.sliding<Snapshot>(8);

    const refresh = Effect.gen(function* () {
      const result: any = yield* rpc.callOption('session.snapshot');
      const snapshot = result?.snapshot;
      if (!snapshot || typeof snapshot !== 'object') return;

      // A workspace shows the branch of the first pane that has a directory.
      const firstCwd = new Map<string, string>();
      for (const pane of snapshot.panes ?? []) {
        const id = pane?.workspace_id;
        if (id && !firstCwd.has(id) && pane.cwd) firstCwd.set(id, pane.cwd);
      }
      for (const workspace of snapshot.workspaces ?? []) {
        const branch = yield* gitBranch(firstCwd.get(workspace?.workspace_id));
        if (branch) workspace.git_branch = branch;
      }

      const next: Snapshot = {
        workspaces: snapshot.workspaces ?? [],
        tabs: snapshot.tabs ?? [],
        panes: snapshot.panes ?? [],
      };
      yield* Ref.set(held, next);
      yield* PubSub.publish(hub, next);
    });

    // Herdr is a desktop app being driven by a person: a second is plenty, and
    // anything faster only spends pipe calls nobody is waiting for.
    yield* refresh.pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(1))),
      Effect.forkScoped,
    );

    return {
      current: Ref.get(held),
      changes: Stream.fromPubSub(hub),
      pane: (paneId) =>
        Ref.get(held).pipe(
          Effect.map((snapshot) => {
            const found = snapshot.panes.find((p: any) => p.pane_id === paneId);
            return found ? toPaneInfo(found) : null;
          }),
        ),
    };
  }),
);
