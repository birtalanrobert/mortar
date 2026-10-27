/**
 * How a terminal is written to when `pretty` is on.
 *
 * One line an entry, its fields after the message, so a service's output
 * reads as a run of events: written one field a line, as `pino-pretty` does
 * unless told otherwise, a single request took eleven lines and a minute of
 * play scrolled out of reach. An error's stack still runs beneath its entry,
 * which is where a stack is read.
 */
export const PRETTY_OPTIONS = {
  colorize: true,
  translateTime: 'HH:MM:ss.l',
  ignore: 'pid,hostname',
  singleLine: true,
} as const;
