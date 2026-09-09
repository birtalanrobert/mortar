import { describe, expect, it } from 'vitest';
import { ChannelCursor, missing } from './gaps';

const event = (channel: string, seq: number) => ({
  channel,
  seq,
  type: 'ticket.created',
  data: {},
  at: 0,
});

/**
 * The few lines every reconnection in five products runs through.
 *
 * A bug here is a kitchen display that is quietly one ticket behind, and quiet
 * is the whole problem: a screen showing four tickets looks exactly like a
 * screen showing four tickets and nothing new.
 */
describe('a client’s position in a channel', () => {
  it('takes the first event it sees as its position', () => {
    const cursor = new ChannelCursor();

    // A new screen joining mid-service does not want yesterday's tickets, and
    // has no basis for calling anything a gap.
    expect(cursor.offer(event('station:grill', 412))).toBe('take');
    expect(cursor.seenAt('station:grill')).toBe(412);
  });

  it('takes the next one', () => {
    const cursor = new ChannelCursor();
    cursor.start('station:grill', 412);

    expect(cursor.offer(event('station:grill', 413))).toBe('take');
    expect(cursor.seenAt('station:grill')).toBe(413);
  });

  it('skips one it has already seen, without complaining', () => {
    const cursor = new ChannelCursor();
    cursor.start('station:grill', 413);

    /*
     * Duplicates are **normal**, not an error: a resume overlaps the live
     * stream by design, because the alternative is a race in which the gap
     * between "here is your backlog" and "you are now live" loses an event.
     */
    expect(cursor.offer(event('station:grill', 412))).toBe('skip');
    expect(cursor.offer(event('station:grill', 413))).toBe('skip');
    expect(cursor.seenAt('station:grill')).toBe(413);
  });

  it('calls a jump a gap, and does not move', () => {
    const cursor = new ChannelCursor();
    cursor.start('station:grill', 412);

    expect(cursor.offer(event('station:grill', 415))).toBe('gap');

    /*
     * The cursor still says 412, which is the point. Advancing to 415 would
     * make the resume that follows ask for what it just received and lose
     * exactly the events it noticed were missing.
     */
    expect(cursor.seenAt('station:grill')).toBe(412);
  });

  it('keeps one channel’s position out of another’s', () => {
    const cursor = new ChannelCursor();
    cursor.start('station:grill', 412);

    // Per channel rather than global: a display must not think it missed the
    // messages a guest's phone received.
    expect(cursor.offer(event('station:pass', 1))).toBe('take');
    expect(cursor.seenAt('station:grill')).toBe(412);
  });

  it('reports where it stands, for a reconnection to ask from', () => {
    const cursor = new ChannelCursor();
    cursor.start('station:grill', 412);
    cursor.offer(event('station:pass', 7));

    expect(cursor.since()).toEqual({ 'station:grill': 412, 'station:pass': 7 });
  });

  it('forgets a channel it has left', () => {
    const cursor = new ChannelCursor();
    cursor.start('station:grill', 412);
    cursor.forget('station:grill');

    // Not zero: a channel nobody is subscribed to must not be asked for on the
    // next reconnection, or a screen resumes something it stopped watching.
    expect(cursor.since()).toEqual({});
  });
});

describe('what a replay did not contain', () => {
  it('finds nothing missing in an unbroken run', () => {
    expect(missing(412, [event('c', 413), event('c', 414), event('c', 415)])).toEqual([]);
  });

  it('names what was trimmed out of the middle', () => {
    // A bounded backlog that rolled while the client was away. The client must
    // reload rather than carry on believing it is complete.
    expect(missing(412, [event('c', 413), event('c', 416)])).toEqual([414, 415]);
  });

  it('names what was trimmed off the front', () => {
    expect(missing(410, [event('c', 414), event('c', 415)])).toEqual([411, 412, 413]);
  });

  it('says nothing about an empty replay', () => {
    /*
     * Nothing came back, which is the *normal* answer for a client that is
     * already up to date — and indistinguishable, from here, from a backlog
     * that has lost everything. The server says which by sending a `gap`
     * frame; this function does not guess.
     */
    expect(missing(412, [])).toEqual([]);
  });
});
