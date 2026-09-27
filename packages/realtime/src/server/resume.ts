import type { BacklogPort } from './backlog';
import type { RealtimeEvent, ServerFrame } from '../wire';

/**
 * What to send a client that says where it stands.
 *
 * The same answer over a socket and over the polling fallback, computed in one
 * place — which is what makes the fallback a fallback rather than a second
 * protocol that behaves slightly differently on the day it is needed.
 *
 * `since` is the client's position in the channel, or `undefined` when it has
 * none. The two are different questions. No position is a client joining: it
 * starts from now. A position of 0 is a client that joined while the channel
 * was empty, and has therefore seen nothing the channel has carried since —
 * so everything held is what it missed.
 *
 * Four outcomes, and the last two are the ones that have to be honest:
 *
 * - **Nothing.** The client is current, or has just joined. The commonest
 *   case, and it must be cheap: a display polling every three seconds mostly
 *   asks for nothing.
 * - **Events.** Everything after where it stood, oldest first.
 * - **A gap, behind.** The client asked from before the backlog reaches. It
 *   cannot be served, and it is told so — a partial replay that looks complete
 *   is the failure this whole package exists to prevent.
 * - **A gap, ahead.** The client stands further along than the channel has ever
 *   been, so the channel started again: a `MemoryBacklog` restarted with its
 *   process. What the client believes it saw is not what the channel holds, and
 *   every event up to its position would be skipped as already seen.
 */
export async function resume(
  backlog: BacklogPort,
  channel: string,
  since: number | undefined,
): Promise<{ events: readonly RealtimeEvent[]; gap: ServerFrame | null; latest: number }> {
  const { oldest, latest, first = 1 } = await backlog.bounds(channel);

  /*
   * No position: a client joining. A screen bolted to a wall and switched on at
   * six in the evening does not want the tickets from lunch, and a `gap` frame
   * would make it reload for nothing.
   */
  if (since === undefined) return { events: [], gap: null, latest };

  // 0 stands just before the channel's first event, whatever that is numbered.
  const position = since === 0 ? first - 1 : since;

  // Current — or a channel with nothing in it and a client that has seen
  // nothing, which is not a gap: there is nothing to have missed.
  if (position === latest) return { events: [], gap: null, latest };

  if (position > latest || position < oldest - 1) {
    return {
      events: [],
      gap: { kind: 'gap', channel, from: latest },
      latest,
    };
  }

  return { events: await backlog.since(channel, position), gap: null, latest };
}
