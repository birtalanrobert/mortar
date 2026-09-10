import { describe, expect, it, vi } from 'vitest';
import { PrintQueue } from './queue';
import { MemoryPrinter } from './transport';
import { Ticket } from './escpos';

/**
 * What happens when a printer is unwell, which is most of what this is for.
 *
 * The bytes are the easy half. The half worth a package is that a job which
 * cannot be printed **reaches a person** — a queue that swallows a failure is a
 * kitchen with no ticket that never learns it has none, and the first anybody
 * knows is a guest asking where their food is.
 */
const job = (printer = 'grill') => ({
  id: 'job-1',
  printer,
  bytes: new Ticket().line('Mici de casă').cut().render(),
  describedAs: 'table 7, grill',
});

describe('printing a job', () => {
  it('prints it, once', async () => {
    const printer = new MemoryPrinter();
    const queue = new PrintQueue({ transportFor: () => printer });

    const outcome = await queue.print(job());

    expect(outcome).toEqual({ state: 'printed', attempts: 1 });
    expect(printer.text()).toContain('Mici de cas');
  });

  it('tries again when a printer is briefly unwell', async () => {
    const printer = new MemoryPrinter();
    printer.breakIt();

    const queue = new PrintQueue({
      transportFor: () => printer,
      sleep: async () => printer.fixIt(),
    });

    const outcome = await queue.print(job());

    // A socket refused mid-shift, a printer busy with the ticket before. The
    // failures worth retrying are the ones that pass on their own.
    expect(outcome).toEqual({ state: 'printed', attempts: 2 });
  });

  it('tells somebody when it has run out of attempts', async () => {
    const printer = new MemoryPrinter();
    printer.breakIt();

    const told: string[] = [];
    const queue = new PrintQueue({
      transportFor: () => printer,
      sleep: async () => {},
      onFailure: (failed, reason) => {
        told.push(`${failed.describedAs}: ${reason}`);
      },
    });

    const outcome = await queue.print(job());

    /*
     * §5.1 with a different device in the middle: a ticket that reaches nobody
     * is the cardinal failure, and a queue that counted this instead of saying
     * it would make the kitchen the last to know.
     */
    expect(outcome).toMatchObject({ state: 'failed', attempts: 3 });
    expect(told).toEqual(['table 7, grill: The printer is out of paper.']);
  });

  it('does not retry a printer that does not exist', async () => {
    const told: string[] = [];
    const queue = new PrintQueue({
      transportFor: () => undefined,
      onFailure: (_job, reason) => {
        told.push(reason);
      },
    });

    const outcome = await queue.print(job('a printer nobody configured'));

    /*
     * A configuration mistake rather than a device that is unwell. Retrying it
     * three times would delay the only useful answer by six seconds, and the
     * answer is the same every time.
     */
    expect(outcome).toMatchObject({ state: 'failed', attempts: 0 });
    expect(told[0]).toContain('nobody configured');
  });

  it('backs off between attempts rather than hammering a busy printer', async () => {
    const printer = new MemoryPrinter();
    printer.breakIt();

    const waits: number[] = [];
    const queue = new PrintQueue({
      transportFor: () => printer,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await queue.print(job());

    expect(waits).toEqual([250, 500]);
  });
});

describe('a queue of jobs', () => {
  it('prints them one at a time, in order', async () => {
    const printer = new MemoryPrinter();
    const outcomes: string[] = [];

    const queue = new PrintQueue({ transportFor: () => printer });

    for (const name of ['first', 'second', 'third']) {
      queue.enqueue(
        { id: name, printer: 'grill', bytes: new Ticket().line(name).render() },
        (outcome) => outcomes.push(outcome.state),
      );
    }

    await vi.waitFor(() => expect(outcomes).toHaveLength(3));

    /*
     * Serial, because a thermal printer is a single-threaded device: two jobs
     * sent at once interleave into one ticket with half of each on it, which is
     * worse than either arriving late.
     */
    expect(printer.printed).toHaveLength(3);
    expect(printer.text(0)).toContain('first');
    expect(printer.text(2)).toContain('third');
  });

  it('carries on after one job fails', async () => {
    const printer = new MemoryPrinter();
    const states: string[] = [];

    const queue = new PrintQueue({
      transportFor: () => printer,
      sleep: async () => {},
      attempts: 1,
    });

    printer.breakIt();
    queue.enqueue({ id: 'a', printer: 'grill', bytes: Buffer.from('a') }, (outcome) =>
      states.push(outcome.state),
    );

    await vi.waitFor(() => expect(states).toHaveLength(1));
    printer.fixIt();

    queue.enqueue({ id: 'b', printer: 'grill', bytes: Buffer.from('b') }, (outcome) =>
      states.push(outcome.state),
    );

    await vi.waitFor(() => expect(states).toHaveLength(2));

    // One ticket the kitchen never got must not cost them the next one.
    expect(states).toEqual(['failed', 'printed']);
  });
});
