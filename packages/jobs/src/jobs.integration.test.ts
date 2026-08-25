import { runInContext, getContext } from '@birtalanrobert/context';
import {
  RedisLocks,
  TEST_REDIS_URL,
  createQueueConnection,
  createTestRedis,
  flushTestRedis,
} from '@birtalanrobert/redis';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineJob } from './job';
import { JobQueues } from './queue';
import { TaskScheduler } from './scheduler';
import { JobWorkers } from './worker';

const PREFIX = `jobs-test-${Math.random().toString(36).slice(2, 8)}`;

interface SendReminder {
  bookingId: string;
}

const sendReminder = defineJob<SendReminder>({
  name: 'reminder.send',
  queue: 'notifications',
  idFor: (payload) => `reminder-${payload.bookingId}`,
});

// Its own queue: a queue is a concurrency pool, so two worker instances
// consuming one queue compete for its jobs.
const failing = defineJob<{ attempt: string }>({
  name: 'always.fails',
  queue: 'dead-letter-test',
  options: { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
});

let connection: Redis;
let queues: JobQueues;
let workers: JobWorkers;

const settled = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  connection = createQueueConnection({ url: TEST_REDIS_URL });
  queues = new JobQueues({ connection, prefix: PREFIX });
  workers = new JobWorkers({ connection, prefix: PREFIX, concurrency: 4 });
});

afterAll(async () => {
  await workers.close();
  await queues.close();
  await connection.quit();
});

describe('enqueue and process', () => {
  it('runs the handler with a typed payload', async () => {
    const seen: string[] = [];
    workers.register(sendReminder, async (payload) => void seen.push(payload.bookingId));

    await queues.enqueue(sendReminder, { bookingId: 'b1' });
    await settled();

    expect(seen).toEqual(['b1']);
  });

  it('does not leak the carried context into the payload', async () => {
    // The context rides along on the job data, but the handler must see the
    // payload it was given, not an envelope.
    const received: unknown[] = [];
    const job = defineJob<{ value: number }>({ name: 'payload.clean', queue: 'notifications' });
    workers.register(job, async (payload) => void received.push(payload));

    await runInContext({ tenantId: 't1', correlationId: 'c1' }, () =>
      queues.enqueue(job, { value: 42 }),
    );
    await settled();

    expect(received).toEqual([{ value: 42 }]);
  });

  it('restores the enqueuing context, so job logs correlate with the request', async () => {
    let observed: { correlationId?: string; tenantId?: string; source?: string } = {};
    const job = defineJob<{ n: number }>({ name: 'context.check', queue: 'notifications' });

    workers.register(job, async () => {
      const context = getContext();
      observed = {
        correlationId: context?.correlationId,
        tenantId: context?.tenantId,
        source: context?.source,
      };
    });

    await runInContext(
      { correlationId: 'trace-99', tenantId: 'tenant-7', actor: { id: 'u1', type: 'user' } },
      () => queues.enqueue(job, { n: 1 }),
    );
    await settled();

    // Same correlation, new unit of work.
    expect(observed.correlationId).toBe('trace-99');
    expect(observed.tenantId).toBe('tenant-7');
    expect(observed.source).toBe('job');
  });

  it('deduplicates on the derived job id', async () => {
    // A webhook delivered twice, or a user double-submitting, must not produce
    // two reminders.
    const seen: string[] = [];
    const job = defineJob<SendReminder>({
      name: 'reminder.dedupe',
      queue: 'notifications',
      idFor: (p) => `dedupe-${p.bookingId}`,
    });
    workers.register(job, async (p) => void seen.push(p.bookingId));

    await queues.enqueue(job, { bookingId: 'same' });
    await queues.enqueue(job, { bookingId: 'same' });
    await queues.enqueue(job, { bookingId: 'same' });
    await settled();

    expect(seen).toEqual(['same']);
  });

  it('enqueues a batch in one round trip', async () => {
    const seen: string[] = [];
    const job = defineJob<{ id: string }>({ name: 'bulk.item', queue: 'notifications' });
    workers.register(job, async (p) => void seen.push(p.id));

    const count = await queues.enqueueMany(job, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await settled();

    expect(count).toBe(3);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('does nothing for an empty batch', async () => {
    const job = defineJob<{ id: string }>({ name: 'bulk.empty', queue: 'notifications' });
    expect(await queues.enqueueMany(job, [])).toBe(0);
  });
});

describe('retries and the dead-letter hook', () => {
  it('retries, then reports exhaustion exactly once', async () => {
    const deadLettered: string[] = [];
    const attempts: number[] = [];

    const localWorkers = new JobWorkers({
      connection,
      prefix: PREFIX,
      onDeadLetter: (job) => void deadLettered.push(job.name),
    });

    localWorkers.register(failing, async () => {
      attempts.push(Date.now());
      throw new Error('provider unavailable');
    });

    await queues.enqueue(failing, { attempt: 'x' });
    await settled(800);

    expect(attempts.length).toBe(2); // the configured attempt count
    expect(deadLettered).toEqual(['always.fails']);

    await localWorkers.close();
  });

  it('turns a thrown non-Error into a real Error', async () => {
    // Otherwise the failure reaches BullMQ without a stack and is
    // undiagnosable from the logs.
    const deadLettered: Error[] = [];
    const job = defineJob<{ x: number }>({
      name: 'throws.string',
      queue: 'non-error-test',
      options: { attempts: 1 },
    });

    const localWorkers = new JobWorkers({
      connection,
      prefix: PREFIX,
      onDeadLetter: (_job, error) => void deadLettered.push(error),
    });
    localWorkers.register(job, async () => {
      throw 'a bare string';
    });

    await queues.enqueue(job, { x: 1 });
    await settled(500);

    expect(deadLettered[0]).toBeInstanceOf(Error);
    expect(deadLettered[0]?.message).toContain('a bare string');

    await localWorkers.close();
  });
});

describe('registration', () => {
  it('refuses a duplicate handler rather than silently replacing one', async () => {
    const job = defineJob<{ x: number }>({ name: 'dup.handler', queue: 'other' });
    const local = new JobWorkers({ connection, prefix: PREFIX });
    local.register(job, async () => undefined);
    expect(() => local.register(job, async () => undefined)).toThrow(/already registered/);
    await local.close();
  });
});

describe('scheduled tasks', () => {
  const client = createTestRedis('scheduler-suite');
  const locks = new RedisLocks(client);

  afterAll(async () => {
    await flushTestRedis(client);
    await client.quit();
  });

  beforeEach(async () => {
    await flushTestRedis(client);
  });

  it('runs once across a fleet of replicas', async () => {
    let runs = 0;
    const schedulers = Array.from({ length: 5 }, () => new TaskScheduler(locks));

    await Promise.all(
      schedulers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.register({
              name: 'nightly-close',
              intervalMs: 60_000,
              runOnStart: true,
              lockTtlMs: 5_000,
              run: async () => {
                runs += 1;
              },
            });
            setTimeout(resolve, 150);
          }),
      ),
    );

    expect(runs).toBe(1);
    for (const s of schedulers) s.stop();
  });

  it('does not take the process down when a task throws', async () => {
    // A throw escaping an interval callback would kill the process, which is a
    // poor response to one failed nightly report.
    const scheduler = new TaskScheduler(locks);
    scheduler.register({
      name: 'explodes',
      intervalMs: 60_000,
      runOnStart: true,
      run: async () => {
        throw new Error('report generation failed');
      },
    });
    await settled(150);
    scheduler.stop();
    expect(true).toBe(true);
  });

  it('refuses a duplicate task name', () => {
    const scheduler = new TaskScheduler(locks);
    scheduler.register({ name: 'once', intervalMs: 60_000, run: async () => undefined });
    expect(() =>
      scheduler.register({ name: 'once', intervalMs: 60_000, run: async () => undefined }),
    ).toThrow(/already registered/);
    scheduler.stop();
  });
});
