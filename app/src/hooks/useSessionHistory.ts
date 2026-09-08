import { useCallback, useEffect, useRef, useState } from 'react';
import { Effect, Either } from 'effect';
import { HerdrApi } from '../api';
import { HistoryPage, HistoryTurn } from '../history';

/** How often the transcript is asked for new turns while the history is open. */
const REFRESH_MS = 5000;

export type HistoryStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'failed';

/**
 * The transcript behind a pane, loaded when the reader asks for it and then
 * kept up to date with the turns added since. Nothing is fetched until asked:
 * most of the time the live screen is all the reader wants.
 */
export function useSessionHistory(api: HerdrApi, paneId: string) {
  const [status, setStatus] = useState<HistoryStatus>('idle');
  const [turns, setTurns] = useState<HistoryTurn[]>([]);
  const [match, setMatch] = useState<HistoryPage['match'] | null>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  useEffect(() => {
    setStatus('idle');
    setTurns([]);
    setMatch(null);
  }, [api, paneId]);

  const fetchPage = useCallback(
    (after: number) =>
      Effect.runPromise(Effect.either(api.history(paneId, after))).then((result) => {
        if (Either.isLeft(result)) {
          const error = result.left;
          setStatus(error._tag === 'HttpError' && error.status === 404 ? 'missing' : 'failed');
          return;
        }
        const page = result.right;
        setMatch(page.match);
        setTurns((previous) => {
          // The bridge may have re-read the file from the start; trust its numbering.
          const kept = previous.filter((turn) => turn.seq < page.total - page.turns.length);
          return page.turns.length === 0 ? previous : [...kept, ...page.turns];
        });
        setStatus('ready');
      }),
    [api, paneId],
  );

  const load = useCallback(() => {
    setStatus('loading');
    void fetchPage(0);
  }, [fetchPage]);

  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => {
      // The last turn is asked for again: a reply still being written grows in place.
      void fetchPage(Math.max(0, turnsRef.current.length - 1));
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [status, fetchPage]);

  return { status, turns, match, load };
}
