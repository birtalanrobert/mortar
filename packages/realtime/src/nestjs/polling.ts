import type { BacklogPort } from '../server/backlog';
import { resume } from '../server/resume';
import type { RealtimeEvent } from '../wire';

/**
 * The fallback, answered by the same `resume` the socket uses.
 *
 * A product exposes this on a route of its own — it owns authorisation, and the
 * question "may this caller read this channel?" has a different answer in every
 * one of the five products. What it does not own is *what the answer contains*,
 * because a fallback that returns a slightly different thing is a fallback
 * nobody discovers is wrong until the day the sockets stop working.
 *
 * `gaps` is returned rather than thrown: a client polling three channels may be
 * current in two of them and too far behind in the third, and collapsing that
 * into one failure would make it reload everything.
 */
export async function pollSince(
  backlog: BacklogPort,
  channels: readonly string[],
  since: Readonly<Record<string, number>>,
): Promise<{ events: RealtimeEvent[]; gaps: string[]; latest: Record<string, number> }> {
  const events: RealtimeEvent[] = [];
  const gaps: string[] = [];
  const latest: Record<string, number> = {};

  for (const channel of channels) {
    const answer = await resume(backlog, channel, since[channel] ?? 0);

    latest[channel] = answer.latest;
    if (answer.gap) {
      gaps.push(channel);
      continue;
    }

    events.push(...answer.events);
  }

  /*
   * Oldest first across every channel, because a client applies them in order
   * and its cursor is per channel — interleaving is harmless, going backwards
   * within a channel is not.
   */
  events.sort((a, b) => a.at - b.at || a.seq - b.seq);

  return { events, gaps, latest };
}

/** Reads the query a `RealtimeClient` sends when it is polling. */
export function parsePollQuery(query: {
  channels?: string | string[];
  since?: string | string[];
}): { channels: string[]; since: Record<string, number> } {
  const channels = String(
    Array.isArray(query.channels) ? query.channels[0] : (query.channels ?? ''),
  )
    .split(',')
    .map((channel) => channel.trim())
    .filter(Boolean);

  let since: Record<string, number> = {};

  try {
    const raw = Array.isArray(query.since) ? query.since[0] : query.since;
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};

    if (parsed && typeof parsed === 'object') {
      since = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([channel, value]) => [channel, Number(value)]),
      );
    }
  } catch {
    // A malformed cursor is a client starting from now, which is what a client
    // with no cursor does. Refusing would strand a phone that lost its state.
  }

  return { channels, since };
}
