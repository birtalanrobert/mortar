import { describe, expect, it } from 'vitest';
import { isStopRequest, suppressionExpiry, REFUSAL_HOLDS_FOR_DAYS } from './suppression';

describe('when a suppression stops applying', () => {
  it('lets a refusal expire, because people change telephones', () => {
    const now = new Date('2026-03-02T10:00:00Z');
    const expires = suppressionExpiry('refused', now);

    expect(expires).not.toBeNull();
    expect(Math.round((expires!.getTime() - now.getTime()) / 86_400_000)).toBe(
      REFUSAL_HOLDS_FOR_DAYS,
    );
  });

  it('never expires an unsubscribe', () => {
    /*
     * The distinction the whole table exists for. A refusal is a fact about a
     * network and can stop being true; "stop writing to me" was a decision, and
     * quietly resuming after ninety days is the complaint that follows.
     */
    expect(suppressionExpiry('unsubscribed')).toBeNull();
  });
});

describe('reading a reply as "stop"', () => {
  it('recognises what a carrier expects to work', () => {
    for (const word of ['STOP', 'stop', 'Stop.', ' UNSUBSCRIBE ', 'CANCEL', 'quit']) {
      expect(isStopRequest(word), word).toBe(true);
    }
  });

  it('recognises it in the languages this is sold in', () => {
    for (const word of ['oprire', 'Oprește', 'dezabonare', 'leiratkozás', 'ÁLLJ']) {
      expect(isStopRequest(word), word).toBe(true);
    }
  });

  it('does not take a sentence containing the word for a request', () => {
    /*
     * Matching a substring would unsubscribe somebody for confirming an
     * appointment. "Stop by at four" is a customer talking to their salon.
     */
    expect(isStopRequest('stop by at four')).toBe(false);
    expect(isStopRequest('can I cancel my appointment?')).toBe(false);
    expect(isStopRequest('Nem tudok jönni')).toBe(false);
  });
});
