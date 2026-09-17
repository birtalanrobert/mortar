import { describe, expect, it } from 'vitest';
import { RecordingApns, coalesce } from './port';

const push = (pushToken: string, topic = 'pass.ro.stamped.loyalty') => ({ pushToken, topic });

describe('coalescing', () => {
  /**
   * The rule, asserted by counting.
   *
   * A push carries nothing — no serial, no payload — and the device answers it
   * by asking which of *its* passes changed. So a device whose two cards both
   * changed needs one notification, and sending two makes a phone buzz twice
   * for one question it will ask once.
   */
  it('turns many changes on one device into one push', () => {
    expect(coalesce([push('device-a'), push('device-a'), push('device-a')])).toHaveLength(1);
  });

  it('leaves changes on different devices alone', () => {
    const pushes = coalesce([push('device-a'), push('device-b'), push('device-c')]);

    // Five stamps on five customers is five pushes. Only the *same* device
    // collapses.
    expect(pushes.map((one) => one.pushToken).sort()).toEqual(['device-a', 'device-b', 'device-c']);
  });

  it('keeps one device’s two pass types apart', () => {
    const pushes = coalesce([
      push('device-a', 'pass.ro.stamped.loyalty'),
      push('device-a', 'pass.ro.tickets.event'),
    ]);

    /* The topic is half the address: a holder with a card and a ticket has two
       passes on one device, and one push cannot serve both. */
    expect(pushes).toHaveLength(2);
  });

  it('keeps the most recent collapse identifier', () => {
    const pushes = coalesce([
      { ...push('device-a'), collapseId: 'older' },
      { ...push('device-a'), collapseId: 'newer' },
    ]);

    expect(pushes[0]?.collapseId).toBe('newer');
  });

  it('has nothing to say about nothing', () => {
    expect(coalesce([])).toEqual([]);
  });
});

describe('the recording transport', () => {
  it('accepts everything and remembers it', async () => {
    const apns = new RecordingApns();

    const results = await apns.send([push('device-a'), push('device-b')]);

    expect(apns.sent).toHaveLength(2);
    expect(results.every((one) => one.status === 200)).toBe(true);
  });

  /**
   * The one answer that matters more than a success.
   *
   * `410 Unregistered` is the only signal there is that a holder deleted their
   * card without the deregistration arriving, and a product that keeps pushing
   * to it is a product whose delivery numbers are quietly fiction.
   */
  it('can answer the way a device that removed the pass does', async () => {
    const apns = new RecordingApns();
    apns.unregister('device-b');

    const results = await apns.send([push('device-a'), push('device-b')]);

    expect(results.find((one) => one.pushToken === 'device-a')?.status).toBe(200);
    expect(results.find((one) => one.pushToken === 'device-b')).toMatchObject({
      status: 410,
      reason: 'Unregistered',
    });
  });

  it('can refuse for any reason Apple gives', async () => {
    const apns = new RecordingApns();
    apns.refuse('device-a', 400, 'TopicDisallowed');

    const [result] = await apns.send([push('device-a')]);

    expect(result).toMatchObject({ status: 400, reason: 'TopicDisallowed' });
  });

  it('forgets on demand, so one suite does not read another’s pushes', () => {
    const apns = new RecordingApns();
    apns.refuse('device-a', 410, 'Unregistered');
    void apns.send([push('device-a')]);

    apns.clear();

    expect(apns.sent).toEqual([]);
  });
});
