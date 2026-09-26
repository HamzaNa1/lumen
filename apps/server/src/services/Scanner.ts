import {
  Database,
  libraryRoots,
  libraryRootStates,
  mediaSourceAvailability,
  mediaSources,
  Repositories,
  serverScanSeen,
} from "@lumen/database";
import { and, eq, notExists } from "drizzle-orm";
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
  const repositories = yield* Repositories;

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
        const indexed = yield* database
          .select({ id: mediaSources.id })
          .from(mediaSources)
          .where(eq(mediaSources.rootId, rootId))
          .limit(1)
          .get();
        if (indexed != null) {
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
        let sourceId = "";
        yield* database.transaction((transaction) =>
          Effect.gen(function* () {
            let existing = yield* transaction
              .select({ id: mediaSources.id })
              .from(mediaSources)
              .where(eq(mediaSources.absolutePath, target))
              .get();
            if (existing == null) {
              const candidates = yield* transaction
                .select({
                  id: mediaSources.id,
                  absolutePath: mediaSources.absolutePath,
                })
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
                  break;
                }
              }
            }
            sourceId = existing?.id ?? newUuid();
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
                  scannedAtMs: Date.now(),
                })
                .where(eq(mediaSources.id, sourceId));
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
            yield* transaction
              .insert(serverScanSeen)
              .values({ runId, sourceId, seenAtMs })
              .onConflictDoUpdate({
                target: [serverScanSeen.runId, serverScanSeen.sourceId],
                set: { seenAtMs },
              });
          }),
        );
        yield* repositories.scanning
          .createJob({
            id: newUuid(),
            runId,
            parentJobId: null,
            sourceId,
            dedupeKey: `probe:${sourceId}`,
            operation: "probe",
            priority: 500,
            maxAttempts: 5,
            availableAtMs: Date.now(),
          })
          .pipe(Effect.catch(() => Effect.void));
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
            .select({ id: mediaSources.id })
            .from(mediaSources)
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
