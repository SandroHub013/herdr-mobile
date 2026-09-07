import { useEffect, useState } from 'react';
import { Effect, Either } from 'effect';
import { HerdrApi } from '../api';
import { SessionFile } from '../files';

/**
 * How long "not there" is trusted before asking again. A file is often named
 * a moment before it exists, when the agent says what it is about to write.
 */
const MISSING_TTL_MS = 20_000;

type Entry =
  | { readonly status: 'found'; readonly file: SessionFile }
  | { readonly status: 'missing'; readonly at: number }
  | { readonly status: 'pending'; readonly promise: Promise<SessionFile | null> };

const cache = new Map<string, Entry>();

/**
 * Asks the bridge, once per path, whether the file the transcript names is
 * there. The transcript is rendered again on every update with the same
 * paths in it, so the answers are kept for the whole session.
 *
 * `undefined` while the answer is on its way, `null` when there is no such
 * file. Both render as nothing.
 */
export function useSessionFile(
  api: HerdrApi,
  paneId: string,
  workspaceId: string,
  path: string,
): SessionFile | null | undefined {
  const key = `${api.baseUrl}|${paneId}|${path}`;
  const [file, setFile] = useState<SessionFile | null | undefined>(() => {
    const entry = cache.get(key);
    if (entry?.status === 'found') return entry.file;
    if (entry?.status === 'missing') return null;
    return undefined;
  });

  useEffect(() => {
    let alive = true;
    const entry = cache.get(key);
    if (entry?.status === 'found') {
      setFile(entry.file);
      return;
    }
    if (entry?.status === 'missing' && Date.now() - entry.at < MISSING_TTL_MS) {
      setFile(null);
      return;
    }
    const promise = entry?.status === 'pending' ? entry.promise : lookup(api, paneId, workspaceId, path, key);
    void promise.then((result) => {
      if (alive) setFile(result);
    });
    return () => {
      alive = false;
    };
  }, [api, key, paneId, workspaceId, path]);

  return file;
}

function lookup(
  api: HerdrApi,
  paneId: string,
  workspaceId: string,
  path: string,
  key: string,
): Promise<SessionFile | null> {
  const promise = Effect.runPromise(Effect.either(api.fileMeta(paneId, workspaceId, path))).then((result) => {
    if (Either.isRight(result)) {
      cache.set(key, { status: 'found', file: result.right });
      return result.right;
    }
    // Unreachable and missing look the same from here, and are retried the same way.
    cache.set(key, { status: 'missing', at: Date.now() });
    return null;
  });
  cache.set(key, { status: 'pending', promise });
  return promise;
}
