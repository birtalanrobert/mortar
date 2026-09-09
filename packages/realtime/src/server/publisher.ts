import type { BacklogPort } from './backlog';
import type { RealtimeEvent } from '../wire';

/** What a product hands over: a channel, a type and its own payload. */
export interface Publication<T = unknown> {
  readonly channel: string;
  readonly type: string;
  readonly data: T;
}

/** Told about every event, so a transport can fan it out to its own sockets. */
export type Subscriber = (event: RealtimeEvent) => void;

export interface PublisherOptions {
  readonly backlog: BacklogPort;
  /**
   * How an event reaches the *other* gateway processes.
   *
   * A product with one process needs nothing here. A product with four behind a
   * load balancer needs every one of them to hear about an event published on
   * any of them — otherwise a display is served by whichever process happens to
   * hold its socket and sees a third of the tickets. Redis pub/sub is the usual
   * answer, and it is a port so it can be tested without one.
   */
  readonly broadcast?: (event: RealtimeEvent) => Promise<void> | void;
  readonly now?: () => number;
}

/**
 * The one place a sequence number is assigned.
 *
 * Everything this package promises rests on that being true: a number handed
 * out twice is two events a client cannot tell apart, and a number skipped is a
 * gap that will never be filled and will make every client reload for ever.
 *
 * Publishing is *append then fan out*, in that order and never the reverse. A
 * subscriber that received an event before it was durable would be told about
 * something a reconnecting client could not be given — which is the same
 * incompleteness, arriving through the door built to prevent it.
 */
export class RealtimePublisher {
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly options: PublisherOptions) {}

  /** Called by a transport that wants every event, whatever published it. */
  onEvent(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async publish<T>(publication: Publication<T>): Promise<RealtimeEvent<T>> {
    const event = (await this.options.backlog.append(publication.channel, {
      type: publication.type,
      data: publication.data,
      at: this.options.now?.() ?? Date.now(),
    })) as RealtimeEvent<T>;

    // Local sockets first, then the other processes: the fastest path is the
    // one most likely to matter, and neither can be skipped.
    this.deliver(event);
    await this.options.broadcast?.(event);

    return event;
  }

  /**
   * An event that was published somewhere else, arriving over the broadcast.
   *
   * It is **not** appended again — it already has its sequence number, assigned
   * by the process that published it. Appending here would give the same event
   * two numbers and every client a gap.
   */
  receiveBroadcast(event: RealtimeEvent): void {
    this.deliver(event);
  }

  private deliver(event: RealtimeEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        /*
         * One socket's failure is not another's. A subscriber that throws —
         * a closed connection, a serialisation error — must not stop the
         * kitchen's other three screens from being told.
         */
      }
    }
  }
}
