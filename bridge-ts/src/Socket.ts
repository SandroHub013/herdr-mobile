import { HttpLayerRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { Effect, Layer, Stream } from 'effect';
import { BridgeConfig } from './services/Config.ts';
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
}

export const layer = HttpLayerRouter.add(
  'GET',
  '/ws',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* BridgeConfig;
    const snapshots = yield* Snapshots;
    const socket = yield* request.upgrade;
    const write = yield* socket.writer;

    const send = (message: unknown) => write(JSON.stringify(message));

    let authorized = false;

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

      // send_text and send_keys used to come down here as well. They are
      // ordinary requests now: they can fail, and a socket has nowhere to put
      // a failure the reader needs to see.
      return;
    });

    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchAll(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
    Effect.scoped,
  ),
) satisfies Layer.Layer<never, never, unknown>;
