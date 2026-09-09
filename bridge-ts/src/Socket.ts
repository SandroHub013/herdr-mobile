import { HttpLayerRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { Effect, Layer, Queue, Stream } from 'effect';
import { BridgeConfig } from './services/Config.ts';
import { HerdrRpc } from './services/HerdrRpc.ts';
import { Snapshots } from './services/Snapshot.ts';

/**
 * The socket that tells the app when something on the PC changed.
 *
 * It carries snapshots and nothing else. The old one also streamed terminal
 * buffers, a thousand lines per pane every three hundred milliseconds, which
 * is what a screen needs and a conversation does not: the conversation is
 * fetched by revision over HTTP, and only what actually changed comes back.
 *
 * The protocol is the one the app already speaks, so an older build keeps
 * working: an auth frame first, then `snapshot_update` messages, and `ping`
 * answered with `pong`.
 */

/** How long a socket may stay silent before the token is required of it. */
const AUTH_GRACE_MS = 3000;

interface Inbound {
  readonly action?: string;
  readonly token?: string;
  readonly pane_id?: string;
  readonly text?: string;
  readonly keys?: ReadonlyArray<string>;
}

/** Something the phone typed, waiting its turn at the pipe. */
type Typed =
  | { readonly kind: 'text'; readonly paneId: string; readonly text: string }
  | { readonly kind: 'keys'; readonly paneId: string; readonly keys: ReadonlyArray<string> };

export const layer = HttpLayerRouter.add(
  'GET',
  '/ws',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* BridgeConfig;
    const snapshots = yield* Snapshots;
    const rpc = yield* HerdrRpc;
    const socket = yield* request.upgrade;
    const write = yield* socket.writer;

    const send = (message: unknown) => write(JSON.stringify(message));

    let authorized = false;

    /**
     * Typing comes down the socket too, and its order is the whole point.
     * A message is sent as three frames — clear the line, the text, Enter —
     * and if Enter overtook the text the agent would receive an empty line
     * followed by a prompt it never submits. So every frame goes through one
     * queue drained by one fiber, and reaches Herdr in the order it was typed.
     */
    const typed = yield* Queue.unbounded<Typed>();
    yield* Stream.fromQueue(typed).pipe(
      Stream.runForEach((item) =>
        item.kind === 'text'
          ? rpc.callOption('pane.send_text', { pane_id: item.paneId, text: item.text })
          : rpc.callOption('pane.send_keys', { pane_id: item.paneId, keys: item.keys }),
      ),
      Effect.forkScoped,
    );

    /**
     * A socket that never presents a token is closed rather than left open:
     * an unauthenticated connection that simply receives nothing looks to the
     * app like a bridge that is down, and the reader is told to check the
     * wrong thing.
     */
    const deadline = Effect.sleep(AUTH_GRACE_MS).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          authorized
            ? Effect.void
            : send({ type: 'error', error: 'auth_required' }).pipe(
                Effect.andThen(send({ type: 'close' })),
                Effect.orElseSucceed(() => undefined),
              ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* deadline;

    /** Every new snapshot, for as long as this socket is open. */
    const pump = snapshots.changes.pipe(
      Stream.filter(() => authorized),
      Stream.runForEach((snapshot) => send({ type: 'snapshot_update', snapshot })),
      Effect.catchAll(() => Effect.void),
      Effect.forkScoped,
    );
    yield* pump;

    yield* socket.runRaw((frame) => {
      const text = typeof frame === 'string' ? frame : new TextDecoder().decode(frame);
      let message: Inbound;
      try {
        message = JSON.parse(text) as Inbound;
      } catch {
        return;
      }

      if (message.action === 'auth') {
        if (!config.accepts(message.token)) {
          return send({ type: 'error', error: 'auth_required' }).pipe(Effect.orDie);
        }
        authorized = true;
        return Effect.gen(function* () {
          yield* send({ type: 'auth_ok' });
          // The app should not have to wait a second for its first picture.
          yield* send({ type: 'snapshot_update', snapshot: yield* snapshots.current });
        }).pipe(Effect.orElseSucceed(() => undefined));
      }

      if (!authorized) return;

      if (message.action === 'ping') {
        return send({ type: 'pong' }).pipe(Effect.orElseSucceed(() => undefined));
      }

      if (message.action === 'send_text' && message.pane_id && typeof message.text === 'string') {
        return Queue.offer(typed, { kind: 'text', paneId: message.pane_id, text: message.text });
      }

      if (message.action === 'send_keys' && message.pane_id && Array.isArray(message.keys)) {
        return Queue.offer(typed, { kind: 'keys', paneId: message.pane_id, keys: message.keys });
      }

      return;
    });

    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchAll(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
    Effect.scoped,
  ),
) satisfies Layer.Layer<never, never, unknown>;
