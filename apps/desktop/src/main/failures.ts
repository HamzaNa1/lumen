import { RequestCancelledError } from "@lumen/client";

/**
 * Handles the rejection of work nothing waits on by logging it. A request cancelled because its
 * account went away is not a failure.
 */
export const reportFailure =
  (what: string) =>
  (cause: unknown): void => {
    if (!(cause instanceof RequestCancelledError)) console.error(what, cause);
  };

/** Handles a rejection that changes nothing, such as closing what is already closed. */
export const ignoreFailure = (): undefined => undefined;
