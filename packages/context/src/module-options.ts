/**
 * The standard shape for configuring a module from other providers.
 *
 * Every mortar module that takes options offers `forRootAsync`, because the
 * options almost always come from validated configuration — and a module that
 * can only be configured synchronously forces its consumer to read
 * `process.env` directly at import time, which defeats having a config layer
 * at all.
 *
 * Declared here rather than duplicated because it is a type, erased at
 * runtime, and every mortar package already depends on this one.
 */
export interface AsyncModuleOptions<TOptions> {
  /** Modules whose providers the factory injects. Rarely needed for globals. */
  imports?: unknown[];
  /** Tokens passed to the factory, in order. */
  inject?: unknown[];
  useFactory: (...args: never[]) => TOptions | Promise<TOptions>;
}
