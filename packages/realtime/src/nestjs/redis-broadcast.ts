import type { Redis } from 'ioredis';
import type { RealtimePublisher } from '../server/publisher';
import type { RealtimeEvent } from '../wire';

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
 */
export class RedisBroadcast {
  private readonly channel: string;

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    prefix = 'realtime',
  ) {
    this.channel = `${prefix}:fanout`;
  }

  /** Hands local events to the other processes. Pass to `PublisherOptions`. */
  send = async (event: RealtimeEvent): Promise<void> => {
    await this.publisher.publish(this.channel, JSON.stringify(event));
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
        /*
         * `receiveBroadcast`, never `publish`: the event already has its
         * sequence number, assigned by the process that published it.
         * Publishing it again here would give one event two numbers and every
         * client a gap.
         */
        into.receiveBroadcast(JSON.parse(raw) as RealtimeEvent);
      } catch {
        // Rubbish on the channel is somebody else's key collision. Dropping it
        // is right; taking the process down for it is not.
      }
    });
  }
}
