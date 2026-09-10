import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { RealtimePublisher } from '../server/publisher';
import type { RealtimeEvent } from '../wire';

/** What travels on the fan-out channel: the event, and who sent it. */
interface Broadcast {
  readonly from: string;
  readonly event: RealtimeEvent;
}

/**
 * How an event published on one gateway process reaches the others.
 *
 * Four processes behind a load balancer, and a display's socket is held by
 * whichever one it happened to reach. Without this, a ticket published on
 * process two is delivered to the third of the kitchen that is connected to
 * process two — and the other screens are not *told* they are missing it, which
 * is the worst shape a failure can take here.
 *
 * Redis pub/sub rather than sticky routing, which is what the specification
 * asks for and is also the cheaper answer: no session affinity to configure, no
 * reconnection storm when an instance is replaced.
 *
 * **Fire and forget on purpose.** Pub/sub does not deliver to a subscriber that
 * is not connected, and that is *acceptable here and nowhere else*: the event
 * is already durable in the backlog, so a process that missed the broadcast
 * serves it from the resume the moment any client asks. The socket is the fast
 * path; the backlog is the truth.
 *
 * **A process ignores its own broadcasts.** Redis pub/sub delivers to every
 * subscriber on the channel, the sender included, so a process that both sends
 * and listens would hand each of its own events to its sockets twice — once
 * locally and once on the way back. Clients survive it: a duplicate sequence
 * number is `skip`. What they do not survive is nobody noticing that every
 * screen in the building is being sent twice as much as it needs, which on a
 * kitchen tablet over venue wifi is a real cost. Each message carries the id of
 * the process that sent it and is dropped on arrival at that same process.
 */
export class RedisBroadcast {
  private readonly channel: string;

  /**
   * This process, as far as the fan-out is concerned.
   *
   * Generated rather than configured: it exists only to recognise a message
   * coming back, and a value an operator could set is a value two replicas can
   * be given identically — which would make each of them drop the other's
   * events, the one failure this is here to prevent.
   */
  private readonly id = randomUUID();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    prefix = 'realtime',
  ) {
    this.channel = `${prefix}:fanout`;
  }

  /** Hands local events to the other processes. Pass to `PublisherOptions`. */
  send = async (event: RealtimeEvent): Promise<void> => {
    await this.publisher.publish(this.channel, JSON.stringify({ from: this.id, event }));
  };

  /**
   * Starts listening, handing what arrives to the local publisher.
   *
   * The connection is a **separate** one, because a Redis client in subscriber
   * mode may issue no other command — sharing it with the backlog's writes
   * would break both.
   */
  async listen(into: RealtimePublisher): Promise<void> {
    await this.subscriber.subscribe(this.channel);

    this.subscriber.on('message', (channel, raw) => {
      if (channel !== this.channel) return;

      try {
        const message = JSON.parse(raw) as Broadcast;

        // Our own, arriving back. Its sockets already have it.
        if (message.from === this.id) return;

        /*
         * `receiveBroadcast`, never `publish`: the event already has its
         * sequence number, assigned by the process that published it.
         * Publishing it again here would give one event two numbers and every
         * client a gap.
         */
        into.receiveBroadcast(message.event);
      } catch {
        // Rubbish on the channel is somebody else's key collision. Dropping it
        // is right; taking the process down for it is not.
      }
    });
  }
}
