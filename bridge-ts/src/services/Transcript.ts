import fs from 'node:fs/promises';
import { Context, Data, Effect, Layer, Ref } from 'effect';

/**
 * Reading a record that is still being written.
 *
 * Agents append to their session file as they work, and a long session's file
 * runs to tens of megabytes while the phone asks again every few seconds. So
 * the file is read once and thereafter only from where the last read stopped,
 * and the events built so far are kept rather than rebuilt.
 *
 * The state between reads belongs to the adapter: only it knows that a tool
 * result three thousand lines later completes a call near the top. This holds
 * the file position; the adapter holds the meaning.
 */

export class TranscriptError extends Data.TaggedError('TranscriptError')<{
  readonly path: string;
  readonly reason: string;
}> {}

/** What an adapter must provide to be read incrementally. */
export interface Consumer<S> {
  /** Fresh state, for a file seen for the first time or one that was rewritten. */
  readonly init: () => S;
  /** One complete line of the record. Mutates the state; returns nothing. */
  readonly consume: (state: S, line: string) => void;
}

interface Entry {
  offset: number;
  /** A line the last read cut in half, waiting for the rest of itself. */
  partial: string;
  state: unknown;
}

export class Transcript extends Context.Tag('Transcript')<
  Transcript,
  {
    /**
     * Brings the state for `path` up to date with the file and hands it back.
     * A file that shrank is taken as a new one and read from the start.
     */
    readonly read: <S>(
      path: string,
      consumer: Consumer<S>,
    ) => Effect.Effect<S, TranscriptError>;
    /** Forgets a file, so the next read starts over. */
    readonly forget: (path: string) => Effect.Effect<void>;
  }
>() {}

export const layer: Layer.Layer<Transcript> = Layer.effect(
  Transcript,
  Effect.gen(function* () {
    const entries = yield* Ref.make(new Map<string, Entry>());
    // One reader at a time per file: two concurrent reads would both advance
    // the offset and each would consume half the new lines.
    const gate = yield* Effect.makeSemaphore(1);

    const read = <S>(path: string, consumer: Consumer<S>): Effect.Effect<S, TranscriptError> =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const size = yield* Effect.tryPromise({
            try: () => fs.stat(path).then((s) => s.size),
            catch: (cause) => new TranscriptError({ path, reason: String(cause) }),
          });

          const map = yield* Ref.get(entries);
          let entry = map.get(path);
          if (!entry || size < entry.offset) {
            entry = { offset: 0, partial: '', state: consumer.init() };
            map.set(path, entry);
          }
          if (size === entry.offset) return entry.state as S;

          const chunk = yield* Effect.tryPromise({
            try: async () => {
              const handle = await fs.open(path, 'r');
              try {
                const length = size - entry!.offset;
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, entry!.offset);
                return buffer.toString('utf8');
              } finally {
                await handle.close();
              }
            },
            catch: (cause) => new TranscriptError({ path, reason: String(cause) }),
          });

          const lines = (entry.partial + chunk).split('\n');
          entry.partial = lines.pop() ?? '';
          entry.offset = size - Buffer.byteLength(entry.partial, 'utf8');
          for (const line of lines) {
            if (line.trim() === '') continue;
            consumer.consume(entry.state as S, line);
          }
          return entry.state as S;
        }),
      );

    return {
      read,
      forget: (path) => Ref.update(entries, (map) => (map.delete(path), map)),
    };
  }),
);
