import { Effect, Either } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HerdrApi } from '../api';
import type { AgentEvent, AgentInfo, SessionMatch } from '../domain/events';

/**
 * The conversation in a pane, kept current.
 *
 * Events arrive keyed by their number and are merged rather than appended,
 * because the bridge amends what it has already sent: a tool call is written
 * when it starts and rewritten when it finishes, and a background run started
 * an hour ago is closed long after the app first drew it. Appending would show
 * a task that ended at lunchtime as still going.
 */

/** While the agent is working, often enough to feel live without hammering the pipe. */
const BUSY_MS = 1200;
/** When nothing is running, slow down: the phone is on a battery. */
const IDLE_MS = 4000;

export type ConversationStatus =
  | 'loading'
  | 'ready'
  /** This pane has no agent keeping a transcript. */
  | 'missing'
  /** The bridge on the PC is older than the app and has no conversation API. */
  | 'unsupported'
  | 'failed';

export function useConversation(api: HerdrApi, paneId: string | null) {
  const [status, setStatus] = useState<ConversationStatus>('loading');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [match, setMatch] = useState<SessionMatch | null>(null);
  /**
   * Whether the bridge answers `/agent` at all.
   *
   * A pane with no transcript and a bridge that predates the conversation API
   * both reply 404, and telling the reader their window has no agent when the
   * truth is that their PC is running last month's bridge sends them looking
   * in the wrong place entirely. Every pane failing this way is the tell: a
   * bridge that has the route answers it even for a plain shell.
   */
  const [supported, setSupported] = useState(true);

  /** Kept in a ref so the polling loop never restarts just because a reply grew. */
  const bySeq = useRef(new Map<number, AgentEvent>());
  const rev = useRef(0);

  const reset = useCallback(() => {
    bySeq.current = new Map();
    rev.current = 0;
    setEvents([]);
    setAgent(null);
    setMatch(null);
    setStatus('loading');
    setSupported(true);
  }, []);

  useEffect(() => {
    reset();
  }, [api, paneId, reset]);

  /** The manifest is asked for once per pane: it changes when the agent does. */
  useEffect(() => {
    if (!paneId) return;
    let cancelled = false;
    void Effect.runPromise(Effect.either(api.agent(paneId))).then((result) => {
      if (cancelled) return;
      if (Either.isLeft(result)) {
        const error = result.left;
        // 404 here is the route being absent, not the pane: the bridge that
        // has it answers for every pane, agent or not.
        if (error._tag === 'HttpError' && error.status === 404) setSupported(false);
        return;
      }
      setSupported(true);
      setAgent(result.right);
    });
    return () => {
      cancelled = true;
    };
  }, [api, paneId]);

  const pull = useCallback(async () => {
    if (!paneId) return;
    const result = await Effect.runPromise(Effect.either(api.conversation(paneId, rev.current)));

    if (Either.isLeft(result)) {
      const error = result.left;
      setStatus(error._tag === 'HttpError' && error.status === 404 ? 'missing' : 'failed');
      return;
    }

    const page = result.right;
    setMatch(page.match);

    // A bridge that restarted, or a file read again from the top, comes back
    // with a revision behind ours. Its numbering is the truth, so start over.
    if (page.rev < rev.current) bySeq.current = new Map();
    rev.current = page.rev;

    if (page.events.length > 0) {
      for (const event of page.events) bySeq.current.set(event.seq, event);
      setEvents([...bySeq.current.values()].sort((a, b) => a.seq - b.seq));
    }
    setStatus('ready');
  }, [api, paneId]);

  /**
   * Something is still running, so the next look should come sooner. Read off
   * the events themselves rather than a separate flag: the conversation is the
   * only thing that knows.
   */
  const busy = events.some(
    (event) => event._tag === 'Tool' && event.call.status === 'running',
  );

  useEffect(() => {
    if (!paneId) return;
    void pull();
    const timer = setInterval(() => void pull(), busy ? BUSY_MS : IDLE_MS);
    return () => clearInterval(timer);
  }, [paneId, pull, busy]);

  return {
    // An unreachable route outranks whatever the conversation call made of
    // its own 404: there is no conversation to have with this bridge.
    status: supported ? status : ('unsupported' as const),
    events,
    agent,
    match,
    busy,
    refresh: pull,
    reset,
  };
}
