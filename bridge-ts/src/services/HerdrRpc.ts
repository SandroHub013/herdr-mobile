import net from 'node:net';
import path from 'node:path';
import { Context, Data, Duration, Effect, Layer } from 'effect';

/**
 * The line to Herdr itself.
 *
 * Herdr listens on a Windows named pipe and speaks one JSON object per line:
 * a request goes in, a response comes back, the connection closes. Every call
 * opens its own pipe — that is Herdr's protocol, not a shortcut — so the only
 * thing to get right here is that two calls never interleave on one handle.
 */

export class HerdrRpcError extends Data.TaggedError('HerdrRpcError')<{
  readonly method: string;
  readonly reason: string;
}> {
  get message() {
    return `Herdr non risponde a ${this.method}: ${this.reason}`;
  }
}

/**
 * How Herdr names its pipe: the socket's absolute path, pasted whole after the
 * pipe prefix. It looks wrong and it is what Herdr does.
 */
export const pipeEndpoint = (socketPath: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\${path.resolve(socketPath)}` : socketPath;

const CALL_TIMEOUT = Duration.seconds(5);

/** One request, one connection, one line back. */
const rawCall = (
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  id: string,
): Effect.Effect<unknown, HerdrRpcError> =>
  Effect.async<unknown, HerdrRpcError>((resume) => {
    const socket = net.connect(endpoint);
    let buffer = '';
    let settled = false;

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.fail(new HerdrRpcError({ method, reason })));
    };

    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(value));
    };

    socket.setEncoding('utf8');

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        const parsed = JSON.parse(line) as { result?: unknown; error?: { message?: string } };
        if (parsed.error) {
          fail(parsed.error.message ?? JSON.stringify(parsed.error));
          return;
        }
        succeed(parsed.result);
      } catch (cause) {
        fail(`risposta illeggibile (${String(cause)})`);
      }
    });

    // Herdr closing before a full line means it had nothing to say.
    socket.on('end', () => fail('connessione chiusa senza risposta'));
    socket.on('error', (cause) => fail(cause.message));

    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutFail({
      duration: CALL_TIMEOUT,
      onTimeout: () => new HerdrRpcError({ method, reason: 'nessuna risposta entro 5s' }),
    }),
  );

export class HerdrRpc extends Context.Tag('HerdrRpc')<
  HerdrRpc,
  {
    /** Calls a Herdr method. Fails loudly; callers decide what a failure means. */
    readonly call: (
      method: string,
      params?: Record<string, unknown>,
    ) => Effect.Effect<unknown, HerdrRpcError>;
    /** The same, but a failure is just "nothing there" — for polling loops. */
    readonly callOption: (
      method: string,
      params?: Record<string, unknown>,
    ) => Effect.Effect<unknown>;
  }
>() {}

export const layer = (socketPath: string): Layer.Layer<HerdrRpc> =>
  Layer.effect(
    HerdrRpc,
    Effect.gen(function* () {
      const endpoint = pipeEndpoint(socketPath);
      // Herdr answers one request per connection, but it is a single desktop
      // process: firing twenty at once buys nothing and loses responses.
      const gate = yield* Effect.makeSemaphore(4);
      let counter = 0;

      const call = (method: string, params: Record<string, unknown> = {}) =>
        gate.withPermits(1)(
          Effect.suspend(() => {
            counter += 1;
            return rawCall(endpoint, method, params, `bridge-${Date.now()}-${counter}`);
          }),
        );

      return {
        call,
        callOption: (method, params) => call(method, params).pipe(Effect.orElseSucceed(() => null)),
      };
    }),
  );
