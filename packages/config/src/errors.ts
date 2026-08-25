/**
 * Raised at boot when the environment does not satisfy the schema.
 *
 * Deliberately fatal and deliberately verbose: a missing environment variable
 * discovered at boot costs seconds, and the same variable discovered at first
 * use — halfway through a payment, or in a worker at three in the morning —
 * costs an incident.
 */
export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration:\n${issues
        .map((issue) => `  • ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ConfigValidationError';
  }
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}
