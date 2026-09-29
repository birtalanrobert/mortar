import 'reflect-metadata';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { createTestDataSource, runInTransaction } from '@birtalanrobert/database';
import { ValidationError } from '@birtalanrobert/http';
import { defer, from, lastValueFrom } from 'rxjs';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyRecord } from './entity';
import { IDEMPOTENT_KEY, IdempotencyInterceptor } from './interceptor';
import { IdempotencyService } from './service';
import { idempotencyMigrations } from './index';

let dataSource: DataSource;
let service: IdempotencyService;
let interceptor: IdempotencyInterceptor;

beforeAll(async () => {
  dataSource = await createTestDataSource([IdempotencyRecord], {
    migrations: idempotencyMigrations,
  });
  // The handlers' own work, in a table of its own.
  await dataSource.query('CREATE TABLE IF NOT EXISTS idem_work (id text PRIMARY KEY)');
  service = new IdempotencyService(dataSource);
  interceptor = new IdempotencyInterceptor(service, new Reflector());
});

afterAll(async () => {
  if (dataSource?.isInitialized) {
    await dataSource.query('DROP TABLE IF EXISTS idem_work');
    await dataSource.destroy();
  }
});

beforeEach(async () => {
  await dataSource.getRepository(IdempotencyRecord).clear();
  await dataSource.query('DELETE FROM idem_work');
});

/** A route marked `@Idempotent()`, optionally with an `@HttpCode`. */
const route = (httpCode?: number) => {
  const handler = function handler() {};
  Reflect.defineMetadata(IDEMPOTENT_KEY, { required: true }, handler);
  if (httpCode !== undefined) Reflect.defineMetadata(HTTP_CODE_METADATA, httpCode, handler);
  return handler;
};

/** Sends a request to `handler` through the interceptor; `work` is what the handler does. */
const send = (
  work: () => Promise<unknown>,
  {
    key = 'k1',
    params = {},
    body = { item: 'farm' },
    handler = route(),
  }: {
    key?: string;
    params?: Record<string, string>;
    body?: unknown;
    handler?: () => void;
  } = {},
) => {
  const request = {
    method: 'POST',
    route: { path: '/villages/:id/build' },
    params,
    body,
    headers: { 'idempotency-key': key },
  };
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => defer(() => from(work())) };
  return lastValueFrom(interceptor.intercept(context, next));
};

const write = (id: string) =>
  runInTransaction(dataSource, (manager) =>
    manager.query('INSERT INTO idem_work (id) VALUES ($1)', [id]),
  );
const worked = async () =>
  ((await dataSource.query('SELECT id FROM idem_work ORDER BY id')) as Array<{ id: string }>).map(
    (row) => row.id,
  );
const claims = () => dataSource.getRepository(IdempotencyRecord).find();

describe('the key and the work', () => {
  it('commit together: the key is done inside the transaction that did the work', async () => {
    let statusSeenAfterCommit: string | undefined;
    await send(async () => {
      await write('queued');
      // The work has committed and the handler has not answered yet: the key
      // already stands for it, so a crash here cannot free it to run again.
      statusSeenAfterCommit = (await claims())[0]?.status;
      return { id: 'queued' };
    });

    expect(statusSeenAfterCommit).toBe('completed');
  });

  it('answer a repeat with the stored response, doing nothing again', async () => {
    const work = vi.fn(async () => {
      await write('queued');
      return { id: 'queued' };
    });
    await send(work);

    await expect(send(work)).resolves.toEqual({ id: 'queued' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(await worked()).toEqual(['queued']);
  });

  it('answer a repeat with no body when the response was never stored, rather than work again', async () => {
    const complete = vi.spyOn(service, 'complete').mockRejectedValueOnce(new Error('lost'));
    const work = vi.fn(async () => {
      await write('queued');
      return { id: 'queued' };
    });

    // The work is done and the key stands for it: the answer still goes out.
    await expect(send(work)).resolves.toEqual({ id: 'queued' });
    complete.mockRestore();
    await expect(send(work)).resolves.toBeNull();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('record the status the route declares', async () => {
    await send(async () => write('built'), { key: 'created' });
    await send(async () => write('lowered'), { key: 'no-content', handler: route(204) });

    const byKey = Object.fromEntries((await claims()).map((claim) => [claim.key, claim]));
    expect(byKey['created']?.responseStatus).toBe(201);
    expect(byKey['no-content']?.responseStatus).toBe(204);
  });
});

describe('a failed request', () => {
  it('frees the key when nothing committed, so the retry runs', async () => {
    const work = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('refused'))
      .mockImplementationOnce(async () => write('queued'));

    await expect(send(work)).rejects.toThrow('refused');
    expect(await claims()).toEqual([]);
    await send(work);

    expect(work).toHaveBeenCalledTimes(2);
    expect(await worked()).toEqual(['queued']);
  });

  it('frees the key when its transaction rolled back, and the mark went with it', async () => {
    await expect(
      send(() =>
        runInTransaction(dataSource, async (manager) => {
          await manager.query('INSERT INTO idem_work (id) VALUES ($1)', ['half-done']);
          throw new Error('refused');
        }),
      ),
    ).rejects.toThrow('refused');

    expect(await claims()).toEqual([]);
    expect(await worked()).toEqual([]);
  });

  it('frees the key when the only transaction to commit wrote nothing', async () => {
    const work = vi.fn(async () => {
      await runInTransaction(dataSource, (manager) =>
        manager.query('SELECT count(*) FROM idem_work'),
      );
      throw new Error('refused after reading');
    });

    await expect(send(work)).rejects.toThrow('refused after reading');
    expect(await claims()).toEqual([]);
  });

  it('keeps the key spent when the work committed before the failure, so a retry does not repeat it', async () => {
    const work = vi.fn(async () => {
      await write('queued');
      // After the commit: a callback run once it has committed, failing.
      throw new Error('after the commit');
    });

    await expect(send(work)).rejects.toThrow('after the commit');
    await expect(send(work)).resolves.toBeNull();
    expect(work).toHaveBeenCalledTimes(1);
    expect(await worked()).toEqual(['queued']);
  });
});

describe('a key reused', () => {
  it('for another of the route’s targets is refused, not answered with the first’s response', async () => {
    await send(async () => write('farm'), { params: { id: 'village-a' } });

    await expect(
      send(async () => write('farm-elsewhere'), { params: { id: 'village-b' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await worked()).toEqual(['farm']);
  });

  it('for the same target and body is a repeat', async () => {
    const work = vi.fn(async () => write('farm'));
    await send(work, { params: { id: 'village-a' } });
    await send(work, { params: { id: 'village-a' } });

    expect(work).toHaveBeenCalledTimes(1);
  });
});
