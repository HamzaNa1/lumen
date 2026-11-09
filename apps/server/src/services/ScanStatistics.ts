import { type DatabaseClient, type DatabaseTransaction, scanJobs } from "@lumen/database";
import { and, count, eq } from "drizzle-orm";
import { Effect } from "effect";
import { emptyStats } from "./LibraryDiff";

// Refresh runs have no filesystem diff; their only scan statistic is queued probes.
export const scanRunStats = Effect.fn("Scans.runStats")(function* (
  database: DatabaseClient | DatabaseTransaction,
  runId: string,
) {
  const probes = yield* database
    .select({ count: count() })
    .from(scanJobs)
    .where(and(eq(scanJobs.runId, runId), eq(scanJobs.operation, "probe")))
    .get();
  return { ...emptyStats(), probesEnqueued: probes?.count ?? 0 };
});
