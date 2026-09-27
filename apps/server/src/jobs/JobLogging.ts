import { Cause, Effect, Exit } from "effect";
import type { LogFields, Logger } from "../core/Logger";
import { retryDelayMs } from "./ServerJobs";

export const logJobOutcome = (
  logger: Logger,
  fields: LogFields & { readonly attempt: number; readonly maxAttempts: number },
  outcome: Exit.Exit<unknown, unknown>,
  startedAt: number,
): void => {
  const details = { ...fields, durationMs: Math.round(performance.now() - startedAt) };
  if (Exit.isSuccess(outcome)) {
    logger.debug("job_succeeded", details);
  } else {
    const retry = fields.attempt < fields.maxAttempts;
    logger[retry ? "warn" : "error"](
      retry ? "job_retry_scheduled" : "job_failed",
      {
        ...details,
        ...(retry ? { retryDelayMs: retryDelayMs(fields.attempt) } : {}),
      },
      Cause.squash(outcome.cause),
    );
  }
};

// Polling failures can otherwise emit ten identical errors per second during
// an outage. Report the first failure, periodic totals, and recovery.
export const backgroundTask = <A>(
  logger: Logger,
  operation: string,
  task: () => Effect.Effect<A, unknown>,
  fallback: A,
  now: () => number = Date.now,
): (() => Promise<A>) => {
  let failures = 0;
  let lastLoggedAt = 0;
  return async () => {
    const outcome = await Effect.runPromiseExit(Effect.suspend(task));
    if (Exit.isSuccess(outcome)) {
      if (failures > 0) logger.info("background_task_recovered", { operation, failures });
      failures = 0;
      return outcome.value;
    }
    failures += 1;
    if (failures === 1 || now() - lastLoggedAt >= 30_000) {
      logger.error("background_task_failed", { operation, failures }, Cause.squash(outcome.cause));
      lastLoggedAt = now();
    }
    return fallback;
  };
};
