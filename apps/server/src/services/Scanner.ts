import {
  catalogItemOrigins,
  catalogItemSources,
  Database,
  libraryRoots,
  libraryRootStates,
  mediaSourceAvailability,
  mediaSources,
  scanJobs,
  scanRuns,
  serverScanMissing,
  serverScanSeen,
  streams,
} from "@lumen/database";
import { and, eq, exists, inArray, isNull, notExists, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { newUuid } from "../core/Security";
import { safePath } from "../core/Paths";
import { purgeSources, type SourcePurgeCounts } from "./CatalogPurge";

const mediaExtensions = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".ape",
  ".flac",
  ".m4a",
  ".m4v",
  ".mkv",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".wma",
  ".wmv",
]);

const isMedia = (path: string): boolean =>
  mediaExtensions.has(path.slice(path.lastIndexOf(".")).toLowerCase());

const existsFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const walk = async function* (
  root: string,
  current = root,
): AsyncGenerator<{
  absolutePath: string;
  relativePath: string;
  size: number;
  modifiedAtMs: number;
  inode: string;
}> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const relativePath = relative(root, absolutePath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walk(root, absolutePath);
      continue;
    }
    if (!entry.isFile() || !isMedia(entry.name)) continue;
    const details = await stat(absolutePath);
    if (!details.isFile()) continue;
    yield {
      absolutePath,
      relativePath,
      size: details.size,
      modifiedAtMs: Math.trunc(details.mtimeMs),
      inode: String(details.ino),
    };
  }
};

export const scanRoot = (
  rootPath: string,
): AsyncGenerator<{
  absolutePath: string;
  relativePath: string;
  size: number;
  modifiedAtMs: number;
  inode: string;
}> => walk(rootPath);

export interface DiscoveryResult {
  readonly discovered: number;
  // True only when every file under the root was enumerated for this generation.
  readonly complete: boolean;
  readonly generation: number | null;
}

export type CleanupSkipReason = "discovery_incomplete" | "root_unavailable" | "superseded";

export type CleanupResult =
  | ({ readonly skipped: null } & SourcePurgeCounts)
  | { readonly skipped: CleanupSkipReason };

const cleanupKeyPrefix = "cleanup:";
export const cleanupJobKey = (rootId: string, generation: number): string =>
  `${cleanupKeyPrefix}${rootId}:${generation}`;
export const parseCleanupJobKey = (
  key: string,
): { readonly rootId: string; readonly generation: number | null } => {
  const [rootId = "", generation] = key.slice(cleanupKeyPrefix.length).split(":");
  const parsed = Number(generation);
  return {
    rootId,
    generation: generation !== undefined && Number.isSafeInteger(parsed) ? parsed : null,
  };
};

type SourceChange = "new" | "changed" | "moved" | "unchanged";

interface FileState {
  readonly fileSizeBytes: number | null;
  readonly modifiedAtMs: number | null;
  readonly inode: string | null;
}

/** A file is changed when its size, modification time, or inode differ from the stored source. */
const classifyChange = (
  stored: FileState | undefined,
  found: FileState,
  moved: boolean,
): SourceChange => {
  if (stored === undefined) return "new";
  if (
    stored.fileSizeBytes !== found.fileSizeBytes ||
    stored.modifiedAtMs !== found.modifiedAtMs ||
    stored.inode !== found.inode
  )
    return "changed";
  return moved ? "moved" : "unchanged";
};

export interface ScannerShape {
  readonly discover: (runId: string, rootId: string) => Effect.Effect<DiscoveryResult, unknown>;
  // Deletes sources that a complete discovery of `generation` did not see.
  readonly cleanup: (
    runId: string,
    rootId: string,
    generation: number | null,
  ) => Effect.Effect<CleanupResult, unknown>;
}

export const makeScanner = Effect.gen(function* () {
  const database = yield* Database;
  // Ingest sets the fingerprint last, so a missing one means an earlier probe never completed.
  const ingestIncomplete = or(
    isNull(mediaSources.contentFingerprint),
    notExists(
      database
        .select({ value: catalogItemSources.itemId })
        .from(catalogItemSources)
        .where(eq(catalogItemSources.sourceId, mediaSources.id)),
    ),
    exists(
      database
        .select({ value: streams.id })
        .from(streams)
        .where(and(eq(streams.sourceId, mediaSources.id), isNull(streams.ordinal))),
    ),
  );

  const discover: ScannerShape["discover"] = Effect.fn("Scanner.discover")(
    function* (runId, rootId) {
      const root = yield* database
        .select({ path: libraryRoots.path, libraryId: libraryRoots.libraryId })
        .from(libraryRoots)
        .where(and(eq(libraryRoots.id, rootId), eq(libraryRoots.isEnabled, true)))
        .get();
      const incomplete = { discovered: 0, complete: false, generation: null };
      if (root == null) return incomplete;
      const state = yield* database
        .select({ generation: libraryRootStates.scanGeneration })
        .from(libraryRootStates)
        .where(eq(libraryRootStates.rootId, rootId))
        .get();
      if (state == null) return incomplete;
      const run = yield* database
        .select({ mode: scanRuns.mode })
        .from(scanRuns)
        .where(eq(scanRuns.id, runId))
        .get();
      const probeAll = run?.mode !== "incremental";
      let count = 0;
      const files = yield* Effect.tryPromise(() => Array.fromAsync(scanRoot(root.path))).pipe(
        Effect.tapError(() =>
          database
            .update(libraryRootStates)
            .set({
              isAvailable: false,
              unavailableReason: "UNAVAILABLE",
              updatedAtMs: Date.now(),
            })
            .where(eq(libraryRootStates.rootId, rootId)),
        ),
      );
      if (files.length === 0) {
        // An unmounted volume usually reads as an empty directory. Absence is
        // not confirmed, so keep the catalog rather than purging the root.
        // Any remaining entry (folders, sidecars) shows the root is mounted.
        const indexed = yield* database
          .select({ id: mediaSources.id })
          .from(mediaSources)
          .where(eq(mediaSources.rootId, rootId))
          .limit(1)
          .get();
        const entries = indexed == null ? [] : yield* Effect.tryPromise(() => readdir(root.path));
        if (indexed != null && entries.length === 0) {
          yield* database
            .update(libraryRootStates)
            .set({ isAvailable: false, unavailableReason: "EMPTY", updatedAtMs: Date.now() })
            .where(eq(libraryRootStates.rootId, rootId));
          return { discovered: 0, complete: false, generation: state.generation };
        }
      }
      const availableAtMs = Date.now();
      yield* database
        .update(libraryRootStates)
        .set({
          isAvailable: true,
          unavailableReason: null,
          lastSeenAtMs: availableAtMs,
          updatedAtMs: availableAtMs,
        })
        .where(eq(libraryRootStates.rootId, rootId));
      for (const file of files) {
        const current = yield* database
          .select({ generation: libraryRootStates.scanGeneration })
          .from(libraryRootStates)
          .where(eq(libraryRootStates.rootId, rootId))
          .get();
        if (current == null || current.generation !== state.generation)
          return { discovered: count, complete: false, generation: state.generation };
        const target = yield* safePath(root.path, file.relativePath);
        const recorded = yield* database.transaction((transaction) =>
          Effect.gen(function* () {
            const sourceSelection = {
              id: mediaSources.id,
              absolutePath: mediaSources.absolutePath,
              fileSizeBytes: mediaSources.fileSizeBytes,
              modifiedAtMs: mediaSources.modifiedAtMs,
              inode: mediaSources.inode,
            };
            let existing = yield* transaction
              .select(sourceSelection)
              .from(mediaSources)
              .where(eq(mediaSources.absolutePath, target))
              .get();
            let moved = false;
            if (existing == null) {
              const candidates = yield* transaction
                .select(sourceSelection)
                .from(mediaSources)
                .where(
                  and(
                    eq(mediaSources.libraryId, root.libraryId),
                    eq(mediaSources.inode, file.inode),
                    eq(mediaSources.fileSizeBytes, file.size),
                    notExists(
                      transaction
                        .select({ value: serverScanSeen.sourceId })
                        .from(serverScanSeen)
                        .where(
                          and(
                            eq(serverScanSeen.runId, runId),
                            eq(serverScanSeen.sourceId, mediaSources.id),
                          ),
                        ),
                    ),
                  ),
                );
              for (const candidate of candidates) {
                if (!(yield* Effect.promise(() => existsFile(candidate.absolutePath)))) {
                  existing = candidate;
                  moved = true;
                  break;
                }
              }
            } else {
              // A retried discovery must not reclassify a file this run already recorded.
              const seen = yield* transaction
                .select({ value: serverScanSeen.sourceId })
                .from(serverScanSeen)
                .where(
                  and(eq(serverScanSeen.runId, runId), eq(serverScanSeen.sourceId, existing.id)),
                )
                .get();
              if (seen != null) return false;
            }
            const sourceId = existing?.id ?? newUuid();
            const change = classifyChange(
              existing,
              { fileSizeBytes: file.size, modifiedAtMs: file.modifiedAtMs, inode: file.inode },
              moved,
            );
            // Unchanged media is re-probed only when an earlier ingest never completed.
            const needsProbe =
              probeAll ||
              change === "new" ||
              change === "changed" ||
              (yield* transaction
                .select({ id: mediaSources.id })
                .from(mediaSources)
                .where(and(eq(mediaSources.id, sourceId), ingestIncomplete))
                .get()) != null;
            if (existing == null) {
              yield* transaction.insert(mediaSources).values({
                id: sourceId,
                libraryId: root.libraryId,
                rootId,
                relativePath: file.relativePath,
                absolutePath: target,
                kind: "local",
                fileSizeBytes: file.size,
                modifiedAtMs: file.modifiedAtMs,
                inode: file.inode,
                contentFingerprint: null,
                scannedAtMs: Date.now(),
              });
            } else {
              yield* transaction
                .update(mediaSources)
                .set({
                  rootId,
                  relativePath: file.relativePath,
                  absolutePath: target,
                  fileSizeBytes: file.size,
                  modifiedAtMs: file.modifiedAtMs,
                  inode: file.inode,
                  // A changed file stays incomplete until its new probe succeeds.
                  ...(change === "changed" ? { contentFingerprint: null } : {}),
                  scannedAtMs: Date.now(),
                })
                .where(eq(mediaSources.id, sourceId));
            }
            if (moved) {
              // Release the old path so a new file there can claim its own origin.
              yield* transaction
                .update(catalogItemOrigins)
                .set({ rootId, relativePath: file.relativePath })
                .where(
                  inArray(
                    catalogItemOrigins.itemId,
                    transaction
                      .select({ itemId: catalogItemSources.itemId })
                      .from(catalogItemSources)
                      .where(eq(catalogItemSources.sourceId, sourceId)),
                  ),
                );
              // An earlier root's cleanup in this run may have recorded a move source as missing.
              yield* transaction
                .delete(serverScanMissing)
                .where(
                  and(eq(serverScanMissing.runId, runId), eq(serverScanMissing.sourceId, sourceId)),
                );
            }
            const seenAtMs = Date.now();
            yield* transaction
              .insert(mediaSourceAvailability)
              .values({
                sourceId,
                isAvailable: true,
                lastSeenAtMs: seenAtMs,
                missingSinceMs: null,
                updatedAtMs: seenAtMs,
              })
              .onConflictDoUpdate({
                target: mediaSourceAvailability.sourceId,
                set: {
                  isAvailable: true,
                  lastSeenAtMs: seenAtMs,
                  missingSinceMs: null,
                  updatedAtMs: seenAtMs,
                },
              });
            yield* transaction.insert(serverScanSeen).values({ runId, sourceId, seenAtMs, change });
            if (needsProbe)
              yield* transaction
                .insert(scanJobs)
                .values({
                  id: newUuid(),
                  runId,
                  parentJobId: null,
                  sourceId,
                  dedupeKey: `probe:${sourceId}`,
                  operation: "probe",
                  status: "queued",
                  priority: 500,
                  attempts: 0,
                  maxAttempts: 5,
                  availableAtMs: seenAtMs,
                })
                .onConflictDoNothing();
            return true;
          }),
        );
        if (!recorded) continue;
        count += 1;
      }
      return { discovered: count, complete: true, generation: state.generation };
    },
  );

  const cleanup: ScannerShape["cleanup"] = Effect.fn("Scanner.cleanup")(
    function* (runId, rootId, generation) {
      const result: CleanupResult = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          if (generation === null) return { skipped: "discovery_incomplete" } as const;
          const root = yield* transaction
            .select({
              isEnabled: libraryRoots.isEnabled,
              isAvailable: libraryRootStates.isAvailable,
              generation: libraryRootStates.scanGeneration,
            })
            .from(libraryRoots)
            .innerJoin(libraryRootStates, eq(libraryRootStates.rootId, libraryRoots.id))
            .where(eq(libraryRoots.id, rootId))
            .get();
          if (root == null || !root.isEnabled || !root.isAvailable)
            return { skipped: "root_unavailable" } as const;
          if (root.generation !== generation) return { skipped: "superseded" } as const;
          const removed = yield* transaction
            .select({ id: mediaSources.id, isAvailable: mediaSourceAvailability.isAvailable })
            .from(mediaSources)
            .leftJoin(
              mediaSourceAvailability,
              eq(mediaSourceAvailability.sourceId, mediaSources.id),
            )
            .where(
              and(
                eq(mediaSources.rootId, rootId),
                notExists(
                  transaction
                    .select({ value: serverScanSeen.sourceId })
                    .from(serverScanSeen)
                    .where(
                      and(
                        eq(serverScanSeen.runId, runId),
                        eq(serverScanSeen.sourceId, mediaSources.id),
                      ),
                    ),
                ),
              ),
            );
          // Keep per-run missing statistics after the sources themselves are deleted.
          // Older scans already counted unavailable tombstones as missing.
          const missing = removed.filter((source) => source.isAvailable !== false);
          const missingAtMs = Date.now();
          for (let offset = 0; offset < missing.length; offset += 500) {
            yield* transaction
              .insert(serverScanMissing)
              .values(
                missing.slice(offset, offset + 500).map((source) => ({
                  runId,
                  sourceId: source.id,
                  missingAtMs,
                })),
              )
              .onConflictDoNothing();
          }
          const counts = yield* purgeSources(
            transaction,
            removed.map((source) => source.id),
          );
          return { skipped: null, ...counts };
        }),
      );
      if (result.skipped === null)
        console.info("scan_cleanup_completed", { runId, rootId, ...result });
      else console.warn("scan_cleanup_skipped", { runId, rootId, reason: result.skipped });
      return result;
    },
  );

  return { discover, cleanup };
});

export class Scanner extends Context.Service<Scanner, ScannerShape>()("@lumen/server/Scanner") {}

export const ScannerLive = Layer.effect(Scanner, makeScanner);
