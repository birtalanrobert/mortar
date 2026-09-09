import type { RealtimeEvent } from './wire';

/**
 * What a client has seen, and what it has therefore missed.
 *
 * Pure, and separate from anything that holds a socket, because this is the
 * part worth being certain about: every reconnection in every one of the five
 * products that need this package runs through these few lines, and a bug here
 * is a kitchen display that is quietly one ticket behind.
 */
export class ChannelCursor {
  private readonly seen = new Map<string, number>();

  /** Where the client stands in each channel, to send on reconnection. */
  since(): Record<string, number> {
    return Object.fromEntries(this.seen);
  }

  seenAt(channel: string): number {
    return this.seen.get(channel) ?? 0;
  }

  /** Starts a channel at a known point, from a `welcome` or a resume. */
  start(channel: string, seq: number): void {
    this.seen.set(channel, seq);
  }

  forget(channel: string): void {
    this.seen.delete(channel);
  }

  /**
   * Decides what to do with an event that has arrived.
   *
   * Three answers, and the third is the one that matters:
   *
   * - `take` — the next one. Advance and hand it over.
   * - `skip` — one already seen. Duplicates are *normal*: a resume overlaps
   *   with the live stream by design, because the alternative is a race in
   *   which the gap between "here is your backlog" and "you are now live" loses
   *   an event.
   * - `gap` — a jump. Something is missing, and the client must resynchronise
   *   rather than carry on. Nothing is more dangerous here than a client that
   *   quietly renders event 415 after 412 and believes it is up to date.
   */
  offer(event: RealtimeEvent): 'take' | 'skip' | 'gap' {
    const seen = this.seen.get(event.channel);

    // A channel nobody has a position in: this is the position.
    if (seen === undefined) {
      this.seen.set(event.channel, event.seq);
      return 'take';
    }

    if (event.seq <= seen) return 'skip';

    if (event.seq > seen + 1) {
      /*
       * Deliberately **not** advanced. The cursor still says what was actually
       * seen, so the resume that follows asks for the right thing — advancing
       * here would make the client ask for what it just received and lose
       * exactly the events it noticed were missing.
       */
      return 'gap';
    }

    this.seen.set(event.channel, event.seq);
    return 'take';
  }
}

/**
 * Which sequence numbers are missing from a batch.
 *
 * Used by a resume: the server sends what it has, and the client checks that
 * the run is unbroken from where it stood. A backlog that has been trimmed
 * answers with fewer events than the client needs, and this is what notices.
 */
export function missing(from: number, events: readonly RealtimeEvent[]): number[] {
  if (events.length === 0) return [];

  const have = new Set(events.map((event) => event.seq));
  const highest = Math.max(...have);
  const gaps: number[] = [];

  for (let seq = from + 1; seq < highest; seq += 1) {
    if (!have.has(seq)) gaps.push(seq);
  }

  return gaps;
}
