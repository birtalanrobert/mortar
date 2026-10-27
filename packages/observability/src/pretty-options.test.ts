import { Writable } from 'node:stream';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { describe, expect, it } from 'vitest';
import { PRETTY_OPTIONS } from './pretty-options';

/**
 * The options read by the formatter `createLogger` hands them to — run here in
 * this process, as the transport runs them in a worker, with the colours left
 * out so the text can be compared.
 */
function terminal(): { logger: pino.Logger; text: () => string } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  const logger = pino(
    { base: { service: 'api' } },
    pinoPretty({ ...PRETTY_OPTIONS, colorize: false, destination, sync: true }),
  );
  return { logger, text: () => written.join('') };
}

describe('pretty output', () => {
  it('writes an entry and its fields on one line', () => {
    const { logger, text } = terminal();
    logger.info({ route: '/bookings/:id', statusCode: 200 }, 'request');
    logger.warn('slow');

    const lines = text().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: request \{"service":"api","route":"\/bookings\/:id","statusCode":200\}$/,
    );
    expect(lines[1]).toMatch(/ WARN: slow \{"service":"api"\}$/);
  });

  it('still writes an error’s stack beneath its entry', () => {
    const { logger, text } = terminal();
    logger.error({ err: new Error('boom') }, 'failed');

    const [entry, ...rest] = text().trimEnd().split('\n');
    expect(entry).toMatch(/ ERROR: failed \{"service":"api"\}$/);
    expect(rest.join('\n')).toContain('Error: boom');
  });
});
