import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NetworkPrinter } from './transport';
import { PrintQueue } from './queue';
import { Ticket } from './escpos';

/**
 * A real socket, because raw port 9100 is where the assumptions live.
 *
 * The protocol has no acknowledgement: a printer accepts bytes and says
 * nothing. So "sent" means less here than anywhere else in this repository, and
 * what it *does* mean — the socket connected, accepted the bytes and flushed
 * them — is only testable against something that actually listens.
 */
describe('a network printer', () => {
  let server: Server;
  let received: Buffer[] = [];
  let port = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => received.push(Buffer.concat(chunks)));
    });

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('delivers a whole ticket, including its last line', async () => {
    received = [];
    const printer = new NetworkPrinter({ host: '127.0.0.1', port });

    await printer.send(new Ticket().line('Mici de casă').line('Fără ceapă').cut().render());

    /*
     * Waited for, and the wait is the point rather than a test detail. `send`
     * resolving means the bytes left this machine — raw port 9100 has no
     * acknowledgement, so it cannot mean more than that, and a product reading
     * "printed" as "on paper" is reading something this protocol never says.
     */
    await vi.waitFor(() => expect(received).toHaveLength(1));

    /*
     * The tail is what a naive implementation loses: destroying the socket
     * after `write` can drop what is still in the kernel's buffer, and on a
     * kitchen ticket that is the last item and the cut.
     */
    const text = received[0]!.toString('latin1');
    expect(text).toContain('ceap');
    expect([...received[0]!]).toContain(0x56); // the cut command survived
  });

  it('gives up on a printer that is switched off', async () => {
    // A device with a DHCP lease and no power. The queue must find out in
    // seconds, not hang behind it for the rest of the shift.
    const printer = new NetworkPrinter({ host: '127.0.0.1', port: 9, timeoutMs: 300 });

    await expect(printer.send(Buffer.from('x'))).rejects.toThrow();
  });

  it('escalates a printer nobody can reach, after trying', async () => {
    const told: string[] = [];

    const queue = new PrintQueue({
      transportFor: () => new NetworkPrinter({ host: '127.0.0.1', port: 9, timeoutMs: 200 }),
      attempts: 2,
      backoffMs: () => 10,
      onFailure: (_job, reason) => told.push(reason),
    });

    const outcome = await queue.print({
      id: 'job-1',
      printer: 'grill',
      bytes: new Ticket().line('Mici').render(),
      describedAs: 'table 7, grill',
    });

    expect(outcome).toMatchObject({ state: 'failed', attempts: 2 });
    expect(told).toHaveLength(1);
  });
});
