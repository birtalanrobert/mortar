import type { Redis } from 'ioredis';

export interface RedisHealth {
  readonly status: 'up' | 'down';
  readonly latencyMs?: number;
  readonly error?: string;
  readonly memoryUsedBytes?: number;
  readonly connectedClients?: number;
}

/**
 * Pings Redis and reports basic pressure.
 *
 * Memory matters more than the boolean here: Redis serving every command
 * happily while approaching `maxmemory` is about to start evicting keys, and
 * for a service using it as a lock or hold store, eviction is a correctness
 * failure rather than a performance one.
 */
export async function checkRedisHealth(client: Redis, timeoutMs = 3000): Promise<RedisHealth> {
  const startedAt = process.hrtime.bigint();

  try {
    await withTimeout(client.ping(), timeoutMs);
    const latencyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1000) / 1000;

    let memoryUsedBytes: number | undefined;
    let connectedClients: number | undefined;
    try {
      const info = await withTimeout(client.info(), timeoutMs);
      memoryUsedBytes = parseInfoNumber(info, 'used_memory');
      connectedClients = parseInfoNumber(info, 'connected_clients');
    } catch {
      // INFO can be disabled by policy; the ping already proved liveness.
    }

    return { status: 'up', latencyMs, memoryUsedBytes, connectedClients };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseInfoNumber(info: string, field: string): number | undefined {
  const match = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
  return match?.[1] ? Number(match[1]) : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis check timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
