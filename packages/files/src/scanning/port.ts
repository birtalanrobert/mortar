export type ScanVerdict = { clean: true } | { clean: false; threat: string };

/**
 * A virus scanner.
 *
 * The first thing that happens to an uploaded file and the gate everything else
 * waits behind. The order is not a preference: a professional downloads what
 * their client sent, and a document collection product that hands a bookkeeper
 * a malicious file has done the one thing it must never do. Thumbnailing,
 * assembling and delivering all come after this returns clean.
 *
 * A port because the answer to "which scanner" is a deployment decision — a
 * container beside the worker for most, a vendor's API for a customer whose
 * policy names one.
 */
export interface ScannerPort {
  scan(content: Buffer): Promise<ScanVerdict>;
  /** Whether the scanner is reachable, for the readiness probe. */
  available(): Promise<boolean>;
}

/**
 * A scanner that refuses everything.
 *
 * The default when none is configured, and deliberately not one that passes
 * everything. A misconfiguration that silently disables virus scanning is
 * indistinguishable from working software right up until it matters; one that
 * refuses uploads is noticed within minutes of a deployment.
 */
export class RefusingScanner implements ScannerPort {
  async scan(): Promise<ScanVerdict> {
    return { clean: false, threat: 'no scanner configured' };
  }

  async available(): Promise<boolean> {
    return false;
  }
}

/**
 * A scanner that passes everything, for tests only.
 *
 * Named so that it cannot be mistaken for something else in a configuration
 * file, and kept beside the refusing one so the difference is visible in the
 * same screenful.
 */
export class PermissiveTestScanner implements ScannerPort {
  async scan(): Promise<ScanVerdict> {
    return { clean: true };
  }

  async available(): Promise<boolean> {
    return true;
  }
}
