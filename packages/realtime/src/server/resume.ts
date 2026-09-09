import type { BacklogPort } from './backlog';
import type { RealtimeEvent, ServerFrame } from '../wire';

/**
 * What to send a client that says where it stands.
 *
 * The same answer over a socket and over the polling fallback, computed in one
 * place — which is what makes the fallback a fallback rather than a second
 * protocol that behaves slightly differently on the day it is needed.
 *
 * Three outcomes, and the third is the one that has to be honest:
 *
 * - **Nothing.** The client is current. The commonest case, and it must be
 *   cheap: a display polling every three seconds mostly asks for nothing.
 * - **Events.** Everything after where it stood, oldest first.
 * - **A gap.** The client asked from before the backlog reaches. It cannot be
 *   served, and it is told so — a partial replay that looks complete is the
 *   failure this whole package exists to prevent.
 */
export async function resume(
  backlog: BacklogPort,
  channel: string,
  since: number,
): Promise<{ events: readonly RealtimeEvent[]; gap: ServerFrame | null; latest: number }> {
  const { oldest, latest } = await backlog.bounds(channel);

  // A channel with nothing in it. Not a gap: there is nothing to have missed.
  if (latest === 0) return { events: [], gap: null, latest: 0 };

  /*
   * `since === 0` means "I am new here" rather than "I have seen nothing and
   * want everything since the beginning of time". A screen bolted to a wall and
   * switched on at six in the evening does not want the tickets from lunch, and
   * a `gap` frame would make it reload for nothing.
   */
  if (since === 0) return { events: [], gap: null, latest };

  if (since < oldest - 1) {
    return {
      events: [],
      gap: { kind: 'gap', channel, from: latest },
      latest,
    };
  }

  return { events: await backlog.since(channel, since), gap: null, latest };
}
