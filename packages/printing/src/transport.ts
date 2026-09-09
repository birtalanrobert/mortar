import { connect, type Socket } from 'node:net';

/**
 * How bytes reach a printer.
 *
 * A port, because the products need three: a network printer on port 9100 in a
 * kitchen, a virtual one in every developer's Compose stack, and — for project
 * 12 — a shop's Bluetooth printer reached through something else entirely. The
 * guarantee above it does not change with any of them.
 */
export interface PrinterTransport {
  /**
   * Sends, and resolves only when the bytes have left this machine.
   *
   * Resolving early is the failure worth naming: raw port 9100 has no
   * acknowledgement, so "sent" already means less here than anywhere else in
   * this repository. It must at least mean the socket accepted and flushed
   * them — a promise that resolves on `write` returning true is a promise about
   * a buffer.
   */
  send(bytes: Buffer): Promise<void>;
}

export interface NetworkPrinterOptions {
  readonly host: string;
  /** 9100 is the de facto standard every ESC/POS device in a kitchen listens on. */
  readonly port?: number;
  /**
   * How long to wait for a printer that is switched off but still has a DHCP
   * lease.
   *
   * Short on purpose. A kitchen printer is either there or it is not, and a
   * thirty-second hang is a print queue that backs up behind a device somebody
   * unplugged this morning.
   */
  readonly timeoutMs?: number;
}

/**
 * A network thermal printer, spoken to directly.
 *
 * One connection per job rather than a pool. A kitchen printer is a
 * single-threaded device that prints what it is given in the order it arrives;
 * holding a socket open across jobs buys nothing and loses the one thing that
 * matters — knowing, per ticket, whether the bytes reached it.
 */
export class NetworkPrinter implements PrinterTransport {
  constructor(private readonly options: NetworkPrinterOptions) {}

  async send(bytes: Buffer): Promise<void> {
    const port = this.options.port ?? 9100;
    const timeout = this.options.timeoutMs ?? 5_000;

    await new Promise<void>((resolve, reject) => {
      const socket: Socket = connect({ host: this.options.host, port });
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;

        socket.destroy();
        if (error) reject(error);
        else resolve();
      };

      socket.setTimeout(timeout);
      socket.on('timeout', () =>
        finish(new Error(`The printer at ${this.options.host}:${port} did not answer.`)),
      );
      socket.on('error', (error) => finish(error));

      socket.on('connect', () => {
        /*
         * `end` rather than `write` then `destroy`: it flushes what is queued
         * and closes cleanly, and its callback is the closest thing this
         * protocol has to an acknowledgement. Destroying instead can drop the
         * tail of a ticket that was still in the kernel's buffer.
         */
        socket.end(bytes, () => finish());
      });
    });
  }
}

/**
 * A printer that keeps what it was sent, for tests and for development.
 *
 * Exported rather than kept beside the tests because every product that
 * consumes this package needs a way to assert what a ticket contained without
 * owning a printer — otherwise each writes a fake that disagrees with the
 * interface in its own way.
 */
export class MemoryPrinter implements PrinterTransport {
  readonly printed: Buffer[] = [];
  private failing = false;

  async send(bytes: Buffer): Promise<void> {
    if (this.failing) throw new Error('The printer is out of paper.');

    this.printed.push(Buffer.from(bytes));
  }

  /** What was printed, as text, for a test that reads like a ticket. */
  text(index = -1): string {
    const last = this.printed.at(index);
    return last ? last.toString('latin1') : '';
  }

  /** Makes it fail, because the behaviour worth testing is what happens then. */
  breakIt(): void {
    this.failing = true;
  }

  fixIt(): void {
    this.failing = false;
  }

  clear(): void {
    this.printed.length = 0;
  }
}
