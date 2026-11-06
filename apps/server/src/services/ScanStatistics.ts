import type { ScanRunStats } from "@lumen/contracts";
import {
  type DatabaseClient,
  type DatabaseTransaction,
  scanJobs,
  serverScanMissing,
  serverScanSeen,
} from "@lumen/database";
import { and, count, eq, notExists } from "drizzle-orm";
import { Effect } from "effect";

export const scanRunStats = Effect.fn("Scans.runStats")(function* (
  database: DatabaseClient | DatabaseTransaction,
  runId: string,
) {
  const changes = yield* database
    .select({ change: serverScanSeen.change, count: count() })
    .from(serverScanSeen)
    .where(eq(serverScanSeen.runId, runId))
    .groupBy(serverScanSeen.change);
  const byChange = new Map(changes.map((entry) => [entry.change, entry.count]));
  const skipped = yield* database
    .select({ count: count() })
    .from(serverScanSeen)
    .where(
      and(
        eq(serverScanSeen.runId, runId),
        notExists(
          database
            .select({ value: scanJobs.id })
            .from(scanJobs)
            .where(
              and(
                eq(scanJobs.runId, runId),
                eq(scanJobs.sourceId, serverScanSeen.sourceId),
                eq(scanJobs.operation, "probe"),
              ),
            ),
        ),
      ),
    )
    .get();
  const missing = yield* database
    .select({ count: count() })
    .from(serverScanMissing)
    .where(eq(serverScanMissing.runId, runId))
    .get();
  const probes = yield* database
    .select({ count: count() })
    .from(scanJobs)
    .where(and(eq(scanJobs.runId, runId), eq(scanJobs.operation, "probe")))
    .get();
  return {
    discovered: changes.reduce((total, entry) => total + entry.count, 0),
    new: byChange.get("new") ?? 0,
    changed: byChange.get("changed") ?? 0,
    moved: byChange.get("moved") ?? 0,
    unchanged: byChange.get("unchanged") ?? 0,
    skipped: skipped?.count ?? 0,
    missing: missing?.count ?? 0,
    probesEnqueued: probes?.count ?? 0,
  } satisfies ScanRunStats;
});
