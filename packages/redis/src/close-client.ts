import type { Redis } from 'ioredis';

/**
 * Closes a client: `QUIT` when it is connected, so what it has in flight is
 * answered first, and a disconnect otherwise. `QUIT` is a command, and on a
 * client that is not connected a command waits — behind any other still
 * waiting, a subscription asked for while Redis was down — until its timeout
 * rejects it, or for ever on a connection with none: an application told to
 * stop during an outage failed its shutdown five seconds later. Nothing in
 * flight can be answered without a connection anyway.
 */
export async function closeClient(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    await client.quit();
    return;
  }
  client.disconnect();
}
