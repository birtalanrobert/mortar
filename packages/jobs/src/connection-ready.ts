import type { ConnectionOptions } from 'bullmq';

/**
 * Whether a queue's connection is connected now: false while it is down, or
 * still connecting. Options rather than a client leave BullMQ to make its own
 * connections, which nothing here can see, and read as connected.
 */
export function connectionReady(connection: ConnectionOptions): boolean {
  const status = (connection as { status?: unknown }).status;
  return typeof status !== 'string' || status === 'ready';
}
