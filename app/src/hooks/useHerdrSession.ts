import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Deferred, Duration, Effect, Fiber, Queue, Ref, Schedule, Stream, SubscriptionRef } from 'effect';
import { createApi, HerdrApi } from '../api';
import { SocketError } from '../errors';
import { Snapshot } from '../types';

/**
 * Live connection to the Herdr bridge.
 *
 * The socket, the ping loop, the watchdog and the reconnect delay used to be
 * five mutable refs and three places that cleared timers. They are now one
 * scoped Effect: whatever is acquired inside the scope is released when the
 * scope closes, whether the socket died, the watchdog fired, or React unmounted.
 */

const EMPTY_SNAPSHOT: Snapshot = { workspaces: [], tabs: [], panes: [] };

const PING_INTERVAL = Duration.seconds(8);
const WATCHDOG_INTERVAL = Duration.seconds(5);
const SILENCE_LIMIT_MS = 25000;
const OUTBOX_CAPACITY = 64;
const INBOX_CAPACITY = 256;
/** How long the bridge gets to answer the token before the attempt is given up. */
const AUTH_TIMEOUT = Duration.seconds(6);
/** The close code the bridge uses when the token was missing or wrong. */
const CLOSE_UNAUTHORIZED = 4401;

/** Ctrl+U: readline "discard line". Clears the remote input before new text. */
const CLEAR_LINE = '\x15';

/** min(exponential, 8 seconds), forever. */
const reconnectPolicy = Schedule.exponential(Duration.millis(800)).pipe(
  Schedule.union(Schedule.spaced(Duration.seconds(8))),
  Schedule.jittered,
);

type Outbound = Record<string, unknown>;

export interface HerdrSession {
  connected: boolean;
  /** The bridge refused the token: the user has to enter it, retrying alone will not help. */
  unauthorized: boolean;
  snapshot: Snapshot;
  api: HerdrApi;
  /**
   * Declares which panes the phone is actually looking at. Nothing streams
   * back any more — the conversation is fetched by revision over HTTP — but
   * the bridge still uses it to know which sessions are worth keeping warm.
   */
  subscribe: (paneIds: string[]) => void;
  sendText: (paneId: string, text: string) => void;
  sendKeys: (paneId: string, keys: string[]) => void;
  /**
   * Types a line and presses Enter, as two events in that order.
   *
   * Sending the text with a trailing "\r" in one chunk does not work against
   * an agent: its input treats a burst of characters as a paste, keeps the
   * newline as part of the text, and never submits. The line then sits in the
   * desktop input box, and the next message is appended to it.
   */
  submit: (paneId: string, text: string) => void;
}

interface Handlers {
  readonly onConnected: () => void;
  readonly onDisconnected: () => void;
  readonly onUnauthorized: () => void;
  readonly onSnapshot: (snapshot: Snapshot) => void;
}

const openSocket = (url: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new WebSocket(url),
      catch: () => new SocketError({ reason: 'failed' }),
    }),
    (socket) =>
      Effect.sync(() => {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // Already closing; nothing else to release.
        }
      }),
  );

type Inbound =
  | { readonly kind: 'snapshot'; readonly snapshot: Snapshot }
  | { readonly kind: 'authorized' }
  | { readonly kind: 'unauthorized' };

const decode = (raw: string): Inbound | null => {
  try {
    const message = JSON.parse(raw) as {
      type?: string;
      error?: string;
      snapshot?: Partial<Snapshot>;
      pane_id?: string;
      text?: string;
    };
    if (message.type === 'auth_ok') return { kind: 'authorized' };
    if (message.type === 'error' && message.error === 'auth_required') return { kind: 'unauthorized' };
    if (message.type === 'snapshot_update' && message.snapshot) {
      return {
        kind: 'snapshot',
        snapshot: {
          workspaces: message.snapshot.workspaces ?? [],
          tabs: message.snapshot.tabs ?? [],
          panes: message.snapshot.panes ?? [],
        },
      };
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * One connection attempt: stays alive until the socket closes, fails, or goes
 * quiet for too long. Failing is how a reconnect is requested.
 *
 * The first thing said on the socket is the token, and nothing else is sent
 * until the bridge has accepted it: a subscription sent before that would be
 * the message the bridge judges instead.
 */
const connection = (
  url: string,
  token: string,
  outbox: Queue.Queue<Outbound>,
  subscription: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>,
  handlers: Handlers,
) =>
  Effect.gen(function* () {
    const socket = yield* openSocket(url);

    const inbox = yield* Queue.sliding<string>(INBOX_CAPACITY);
    const opened = yield* Deferred.make<void, SocketError>();
    const authorized = yield* Deferred.make<void, SocketError>();
    const closed = yield* Deferred.make<never, SocketError>();
    const lastMessageAt = yield* Ref.make(Date.now());

    // All four callbacks are installed in one go, before anything is awaited, so
    // a socket that dies during the handshake cannot slip through unnoticed.
    // The callbacks do not run on a fiber, hence the unsafe entry points; both
    // are no-ops once the deferred is already done.
    yield* Effect.sync(() => {
      const die = (reason: 'closed' | 'failed') => {
        const failure = Effect.fail(new SocketError({ reason }));
        Deferred.unsafeDone(opened, failure);
        Deferred.unsafeDone(authorized, failure);
        Deferred.unsafeDone(closed, failure);
      };
      socket.onopen = () => Deferred.unsafeDone(opened, Effect.void);
      socket.onmessage = (event: WebSocketMessageEvent) => {
        Queue.unsafeOffer(inbox, String(event.data));
      };
      socket.onclose = (event: WebSocketCloseEvent) => {
        if (event.code === CLOSE_UNAUTHORIZED) handlers.onUnauthorized();
        die('closed');
      };
      socket.onerror = () => die('failed');
    });

    yield* Deferred.await(opened);

    const send = (payload: Outbound) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify(payload));
          } catch {
            // The close handler will request a reconnect.
          }
        }
      });

    yield* send({ action: 'auth', token });

    // Inbound messages: stamp the clock, then hand the payload to React.
    yield* Effect.forkScoped(
      Queue.take(inbox).pipe(
        Effect.tap(() => Ref.set(lastMessageAt, Date.now())),
        Effect.tap((raw) =>
          Effect.sync(() => {
            const decoded = decode(raw);
            if (decoded === null) return;
            switch (decoded.kind) {
              case 'authorized':
                Deferred.unsafeDone(authorized, Effect.void);
                return;
              case 'unauthorized':
                handlers.onUnauthorized();
                return;
              case 'snapshot':
                handlers.onSnapshot(decoded.snapshot);
                return;
            }
          }),
        ),
        Effect.forever,
      ),
    );

    // Whichever comes first: the bridge accepting the token, or closing on it.
    yield* Effect.raceFirst(Deferred.await(authorized), Deferred.await(closed)).pipe(
      Effect.timeoutFail({ duration: AUTH_TIMEOUT, onTimeout: () => new SocketError({ reason: 'failed' }) }),
    );

    // Anything the UI wants to say, in order, dropped oldest first if it piles up.
    yield* Effect.forkScoped(Queue.take(outbox).pipe(Effect.flatMap(send), Effect.forever));

    // The current subscription is re-sent on every reconnect, because the stream
    // replays its latest value to a new subscriber.
    yield* Effect.forkScoped(
      subscription.changes.pipe(
        Stream.runForEach((paneIds) =>
          paneIds.length === 0 ? Effect.void : send({ action: 'subscribe_panes', pane_ids: paneIds }),
        ),
      ),
    );

    yield* Effect.forkScoped(send({ action: 'ping' }).pipe(Effect.repeat(Schedule.spaced(PING_INTERVAL))));

    const watchdog = Ref.get(lastMessageAt).pipe(
      Effect.flatMap((stamp) =>
        Date.now() - stamp > SILENCE_LIMIT_MS
          ? Effect.fail(new SocketError({ reason: 'silent' }))
          : Effect.void,
      ),
      Effect.repeat(Schedule.spaced(WATCHDOG_INTERVAL)),
      Effect.flatMap(() => Effect.never),
    );

    yield* Effect.sync(handlers.onConnected);

    // raceFirst, not raceAll: raceAll waits for the first *success*, so a clean
    // close from the bridge would have sat there until the watchdog noticed
    // twenty-five seconds later. Here the first outcome of either wins.
    return yield* Effect.raceFirst(Deferred.await(closed), watchdog);
  }).pipe(
    Effect.scoped,
    Effect.onExit(() => Effect.sync(handlers.onDisconnected)),
  );

export function useHerdrSession(host: string, port: string, token: string): HerdrSession {
  const baseUrl = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}/ws`;
  const api = useMemo(() => createApi(baseUrl, token), [baseUrl, token]);

  const [connected, setConnected] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);

  const connectedRef = useRef(false);
  const outboxRef = useRef<Queue.Queue<Outbound> | null>(null);
  const subscriptionRef = useRef<SubscriptionRef.SubscriptionRef<ReadonlyArray<string>> | null>(null);
  // The pane list React wants, written synchronously so the order of two rapid
  // updates is decided here and not by whichever fiber happens to run first.
  const desiredPanesRef = useRef<ReadonlyArray<string>>([]);

  if (outboxRef.current === null) {
    outboxRef.current = Effect.runSync(Queue.sliding<Outbound>(OUTBOX_CAPACITY));
  }
  if (subscriptionRef.current === null) {
    subscriptionRef.current = Effect.runSync(SubscriptionRef.make<ReadonlyArray<string>>([]));
  }

  const handlers = useMemo<Handlers>(
    () => ({
      onConnected: () => {
        connectedRef.current = true;
        setConnected(true);
        setUnauthorized(false);
      },
      onDisconnected: () => {
        connectedRef.current = false;
        setConnected(false);
      },
      onUnauthorized: () => {
        setUnauthorized(true);
      },
      onSnapshot: (next) => {
        setSnapshot(next);
      },
    }),
    [],
  );

  useEffect(() => {
    setSnapshot(EMPTY_SNAPSHOT);
    // New settings, new verdict: the flag belongs to the token that earned it.
    setUnauthorized(false);

    const outbox = outboxRef.current;
    const subscription = subscriptionRef.current;
    if (!outbox || !subscription) return;

    const fiber = Effect.runFork(
      connection(wsUrl, token, outbox, subscription, handlers).pipe(Effect.retry(reconnectPolicy)),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [wsUrl, token, handlers]);

  const subscribe = useCallback((paneIds: string[]) => {
    const subscription = subscriptionRef.current;
    if (!subscription) return;

    const next = [...paneIds].sort();
    const current = desiredPanesRef.current;
    if (current.length === next.length && next.every((id, index) => id === current[index])) return;
    desiredPanesRef.current = next;

    // Updating a SubscriptionRef takes a permit, so it cannot be run
    // synchronously. Each fiber re-reads the ref above, so they all converge on
    // the same value whatever order they run in.
    Effect.runFork(SubscriptionRef.set(subscription, desiredPanesRef.current));
  }, []);

  const enqueue = useCallback((payload: Outbound) => {
    const outbox = outboxRef.current;
    if (!outbox) return;
    // Sliding queue: this never blocks, so it needs no fiber and keeps the order
    // in which the UI produced the messages.
    Queue.unsafeOffer(outbox, payload);
  }, []);

  const sendText = useCallback(
    (paneId: string, text: string) => {
      if (connectedRef.current) {
        enqueue({ action: 'send_text', pane_id: paneId, text });
        return;
      }
      // Offline, the queue would deliver this minutes later; try once and give up.
      Effect.runFork(api.sendText(paneId, text).pipe(Effect.ignore));
    },
    [api, enqueue],
  );

  const sendKeys = useCallback(
    (paneId: string, keys: string[]) => {
      if (connectedRef.current) {
        enqueue({ action: 'send_keys', pane_id: paneId, keys });
        return;
      }
      Effect.runFork(api.sendKeys(paneId, keys).pipe(Effect.ignore));
    },
    [api, enqueue],
  );

  const submit = useCallback(
    (paneId: string, text: string) => {
      // Ctrl+U clears whatever is already in the remote input line before the
      // new text lands. Without it, a line left in the box (typically because
      // the agent was busy and did not submit the previous send) gets the new
      // text appended to it, and two messages arrive glued together.
      if (connectedRef.current) {
        // The outbox is a FIFO drained by one fiber, so these arrive in order.
        enqueue({ action: 'send_text', pane_id: paneId, text: CLEAR_LINE });
        enqueue({ action: 'send_text', pane_id: paneId, text });
        enqueue({ action: 'send_keys', pane_id: paneId, keys: ['Enter'] });
        return;
      }
      // Offline the steps must be sequenced explicitly, or the Enter can
      // overtake the text it is meant to submit.
      Effect.runFork(
        api.sendText(paneId, CLEAR_LINE).pipe(
          Effect.flatMap(() => api.sendText(paneId, text)),
          Effect.flatMap(() => api.sendKeys(paneId, ['Enter'])),
          Effect.ignore,
        ),
      );
    },
    [api, enqueue],
  );

  return { connected, unauthorized, snapshot, api, subscribe, sendText, sendKeys, submit };
}
