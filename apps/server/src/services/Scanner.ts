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

export interface ScannerShape {
  readonly discover: (runId: string, rootId: string) => Effect.Effect<number, unknown>;
  readonly cleanup: (runId: string, rootId: string) => Effect.Effect<number, unknown>;
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
      if (root == null) return 0;
      const state = yield* database
        .select({ generation: libraryRootStates.scanGeneration })
        .from(libraryRootStates)
        .where(eq(libraryRootStates.rootId, rootId))
        .get();
      if (state == null) return 0;
      let count = 0;
      const files = yield* Effect.promise(() => Array.fromAsync(scanRoot(root.path))).pipe(
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
        if (current == null || current.generation !== state.generation) return count;
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
      return count;
    },
  );

  const cleanup: ScannerShape["cleanup"] = Effect.fn("Scanner.cleanup")(function* (runId, rootId) {
    const removed = yield* database
      .select({ id: mediaSources.id })
      .from(mediaSources)
      .where(
        and(
          eq(mediaSources.rootId, rootId),
          notExists(
            database
              .select({ value: serverScanSeen.sourceId })
              .from(serverScanSeen)
              .where(
                and(eq(serverScanSeen.runId, runId), eq(serverScanSeen.sourceId, mediaSources.id)),
              ),
          ),
        ),
      );
    for (const source of removed) {
      const missingSinceMs = Date.now();
      yield* database
        .insert(mediaSourceAvailability)
        .values({
          sourceId: source.id,
          isAvailable: false,
          lastSeenAtMs: null,
          missingSinceMs,
          updatedAtMs: missingSinceMs,
        })
        .onConflictDoUpdate({
          target: mediaSourceAvailability.sourceId,
          set: { isAvailable: false, missingSinceMs, updatedAtMs: missingSinceMs },
        });
    }
    return removed.length;
  });

  return { discover, cleanup };
});

export class Scanner extends Context.Service<Scanner, ScannerShape>()("@lumen/server/Scanner") {}

export const ScannerLive = Layer.effect(Scanner, makeScanner);
