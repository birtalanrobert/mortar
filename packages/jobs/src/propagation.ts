import { getContext, runInChildContext, type Actor } from '@birtalanrobert/context';

/**
 * The context fields carried into a job.
 *
 * Correlation is the point: a reminder dispatched from an HTTP request should
 * appear in the logs under the same correlation id as the request that caused
 * it, otherwise tracing a user's report stops at the queue boundary.
 */
export interface JobContext {
  correlationId?: string;
  tenantId?: string;
  actor?: Actor;
  locale?: string;
}

/** The key job payloads carry the context under. */
export const CONTEXT_KEY = '__mortarContext';

export type WithContext<T> = T & { [CONTEXT_KEY]?: JobContext };

/** Attaches the current context to a payload at enqueue time. */
export function attachContext<T extends object>(payload: T): WithContext<T> {
  const context = getContext();
  if (!context) return payload;

  return {
    ...payload,
    [CONTEXT_KEY]: {
      correlationId: context.correlationId,
      tenantId: context.tenantId,
      actor: context.actor,
      locale: context.locale,
    },
  };
}

/** Separates the carried context from the payload proper. */
export function detachContext<T extends object>(
  payload: WithContext<T>,
): { payload: T; context: JobContext } {
  const { [CONTEXT_KEY]: context, ...rest } = payload;
  return { payload: rest as T, context: context ?? {} };
}

/**
 * Runs a handler inside the context the job was enqueued with.
 *
 * A fresh request id, because this is a new unit of work — but the *inherited*
 * correlation id, so the job and the request that caused it read as one story.
 */
export function runWithJobContext<T>(
  context: JobContext,
  jobName: string,
  work: () => Promise<T>,
): Promise<T> {
  return runInChildContext(
    {
      source: 'job',
      correlationId: context.correlationId,
      tenantId: context.tenantId,
      actor: context.actor ?? { id: jobName, type: 'system' },
      locale: context.locale,
    },
    work,
  );
}
