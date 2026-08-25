/**
 * RFC 9457 Problem Details — the response body every error in every project
 * returns.
 *
 * One shape for every failure means a client writes one error handler, and a
 * support conversation starts with a `requestId` instead of a screenshot.
 */
export interface ProblemDetails {
  /** A URI identifying the problem type. */
  type: string;
  /** A short, human-readable summary. Stable for a given `code`. */
  title: string;
  /** The HTTP status code. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail?: string;
  /** The path of the specific occurrence. */
  instance?: string;
  /**
   * A stable, machine-readable code.
   *
   * This is the field clients branch on — not `title`, which is prose and may
   * be reworded or translated, and not `status`, which is too coarse to
   * distinguish "seat already sold" from "booking window closed".
   */
  code: string;
  /** Correlates a user's report with the logs. */
  requestId?: string;
  /** Field-level failures, for validation problems. */
  errors?: FieldError[];
  /** Seconds to wait before retrying, for 429 and 503. */
  retryAfter?: number;
  /** Additional problem-specific context. Never contains internals. */
  meta?: Record<string, unknown>;
}

export interface FieldError {
  /** Dotted path to the offending field, e.g. `items.0.quantity`. */
  field: string;
  /** Human-readable description of what is wrong. */
  message: string;
  /** Machine-readable rule that failed, e.g. `min_length`. */
  code?: string;
}

/** The base URI for problem types. Overridden per deployment. */
export const DEFAULT_PROBLEM_BASE_URI = 'https://problems.mortar.dev';

/** Builds the `type` URI for an error code. */
export function problemType(code: string, baseUri = DEFAULT_PROBLEM_BASE_URI): string {
  return `${baseUri.replace(/\/$/, '')}/${code}`;
}

/** The media type problem responses are served as. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
