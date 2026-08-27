import { Socket } from 'node:net';
import type { ScannerPort, ScanVerdict } from './port';

export interface ClamAvOptions {
  host: string;
  port: number;
  /** How long to wait for a verdict before giving up. */
  timeoutMs?: number;
  /**
   * The largest file to send.
   *
   * `clamd` has its own `StreamMaxLength` and terminates the connection when a
   * stream exceeds it — which arrives here as a socket error rather than as a
   * verdict. Refusing first turns that into a message somebody can act on.
   */
  maxBytes?: number;
}

const CHUNK = 64 * 1024;

/**
 * `clamd` over its INSTREAM protocol.
 *
 * The wire format is: `zINSTREAM\0`, then a sequence of length-prefixed chunks,
 * then a zero-length chunk to end the stream. The daemon replies with one line.
 * There is no library dependency here because that is the whole protocol, and a
 * dependency for eighty lines is a supply-chain surface for no benefit.
 */
export class ClamAvScanner implements ScannerPort {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: ClamAvOptions) {
    this.host = options.host;
    this.port = options.port;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  }

  async scan(content: Buffer): Promise<ScanVerdict> {
    if (content.length > this.maxBytes) {
      return { clean: false, threat: 'file too large to scan' };
    }

    const reply = await this.converse((socket) => {
      socket.write('zINSTREAM\0');

      for (let offset = 0; offset < content.length; offset += CHUNK) {
        const slice = content.subarray(offset, offset + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(slice.length);
        socket.write(size);
        socket.write(slice);
      }

      // A zero-length chunk ends the stream and asks for the verdict.
      socket.write(Buffer.alloc(4));
    });

    /**
     * `stream: OK` or `stream: <name> FOUND`.
     *
     * Anything else — including `ERROR` — is treated as not clean. A scanner
     * that cannot answer must not be read as a scanner that said yes.
     */
    if (/\bOK\s*$/.test(reply)) return { clean: true };

    const found = /stream:\s*(.+?)\s+FOUND/.exec(reply);
    if (found?.[1]) return { clean: false, threat: found[1] };

    return { clean: false, threat: reply.trim() || 'scanner gave no verdict' };
  }

  async available(): Promise<boolean> {
    try {
      const reply = await this.converse((socket) => socket.write('zPING\0'));
      return reply.includes('PONG');
    } catch {
      return false;
    }
  }

  /**
   * One request, one reply, one connection.
   *
   * `clamd` closes the socket after answering, so the reply is everything read
   * before `end` — there is no framing to parse and no connection to reuse.
   */
  private converse(send: (socket: Socket) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;

      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        outcome();
      };

      socket.setTimeout(this.timeoutMs, () =>
        finish(() => reject(new Error('The virus scanner did not answer in time.'))),
      );
      socket.on('error', (error) => finish(() => reject(error)));
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));

      socket.connect(this.port, this.host, () => {
        try {
          send(socket);
        } catch (error) {
          finish(() => reject(error));
        }
      });
    });
  }
}
