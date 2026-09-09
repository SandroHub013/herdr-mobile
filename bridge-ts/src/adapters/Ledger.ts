import type { AgentEvent, ToolEvent } from '../domain/Event.ts';

/**
 * The events of one session, with a memory of when each last changed.
 *
 * Every adapter needs the same three things and gets them wrong the same way
 * if it writes them itself: a number for each event, a revision that moves
 * on every write, and a record of which event moved at which revision — so
 * the app can ask for what changed since it last looked and get back both the
 * events that were appended and the ones that were amended.
 */
export class Ledger {
  readonly events: AgentEvent[] = [];
  private seq = 0;
  private rev = 0;
  private readonly revBySeq = new Map<number, number>();

  get revision(): number {
    return this.rev;
  }

  private touch(seq: number): void {
    this.rev += 1;
    this.revBySeq.set(seq, this.rev);
  }

  push<E extends AgentEvent>(make: (seq: number) => E): E {
    const event = make(this.seq++);
    this.events.push(event);
    this.touch(event.seq);
    return event;
  }

  /**
   * Swaps an event for a newer version of itself. Events are immutable, so a
   * tool call that finishes is a new object in the old one's place — which is
   * also what makes a half-updated call impossible to observe.
   */
  replace<E extends AgentEvent>(previous: E, next: E): E {
    const at = this.events.indexOf(previous);
    if (at !== -1) this.events[at] = next;
    this.touch(next.seq);
    return next;
  }

  /** Everything that changed after `since`; zero means all of it. */
  changedSince(since: number): AgentEvent[] {
    if (since <= 0) return this.events;
    return this.events.filter((event) => (this.revBySeq.get(event.seq) ?? 0) > since);
  }
}

/** The tool events still waiting for a result, oldest first. */
export const pendingTools = (ledger: Ledger): ToolEvent[] =>
  ledger.events.filter(
    (event): event is ToolEvent => event._tag === 'Tool' && event.call.status === 'running',
  );
