import { Database as Sqlite } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, DatabaseWithMigrationsLive, RepositoriesLive } from "@lumen/database";
import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createLogger, ServerLogger } from "../src/core/Logger";
import { LibraryWatcher, LibraryWatcherLive } from "../src/jobs/LibraryWatcher";
import { LibraryService, LibraryServiceLive } from "../src/services/LibraryService";
import { Scanner, ScannerLive } from "../src/services/Scanner";

// Copy this harness to the baseline checkout too. Discovery includes durable source/job writes,
// but not ffprobe: synthetic files measure reconciliation, not decoder throughput.
interface LegacyScanner {
  discover(runId: string, rootId: string): Effect.Effect<{ generation: number | null }, unknown>;
  cleanup(
    runId: string,
    rootId: string,
    generation: number | null,
  ): Effect.Effect<unknown, unknown>;
}
const existing = process.env.LUMEN_BENCH_DATABASE;
const directory = existing ? undefined : await mkdtemp(join(tmpdir(), "lumen-scan-bench-"));
const filename = existing ?? join(directory as string, "benchmark.sqlite");
const count = Number(process.env.LUMEN_BENCH_FILES ?? 20_000);
const logger = createLogger({ level: "error", format: "json" });
const startup: unknown[] = [];
const database = DatabaseWithMigrationsLive(
  { filename },
  { observe: (event) => startup.push(event) },
);
const dependencies = Layer.mergeAll(database, RepositoriesLive(database));
const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
const scanner = ScannerLive.pipe(Layer.provide(dependencies));
const watcher = LibraryWatcherLive.pipe(
  Layer.provide(Layer.mergeAll(dependencies, libraries, scanner)),
);
const layers = Layer.mergeAll(dependencies, libraries, scanner, watcher).pipe(
  Layer.provide(Layer.succeed(ServerLogger, logger)),
);
const started = performance.now();
try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Database;
        const libraryService = yield* LibraryService;
        const scannerService = yield* Scanner;
        const libraryWatcher = yield* LibraryWatcher;
        const startupMs = performance.now() - started;
        const modern = "reconcile" in scannerService;
        const legacy = scannerService as unknown as LegacyScanner;
        const settle = () =>
          db
            .run(
              sql`UPDATE scan_jobs SET status='succeeded', locked_at_ms=NULL, locked_by=NULL, started_at_ms=max(available_at_ms, ${Date.now()}), finished_at_ms=max(available_at_ms, ${Date.now()}) WHERE status IN ('queued','running')`,
            )
            .pipe(
              Effect.andThen(
                db.run(
                  sql`UPDATE scan_runs SET status='succeeded', finished_at_ms=max(created_at_ms,coalesce(started_at_ms,0),${Date.now()}), started_at_ms=coalesce(started_at_ms,created_at_ms) WHERE status IN ('queued','running')`,
                ),
              ),
            );
        const reconcileLegacy = () =>
          Effect.gen(function* () {
            const runs = yield* db.all<{ run_id: string; root_id: string }>(
              sql`SELECT r.id AS run_id, roots.id AS root_id FROM scan_runs r JOIN library_roots roots ON roots.library_id=r.library_id AND roots.is_enabled=1 WHERE r.status IN ('queued','running') AND r.mode != 'refresh'`,
            );
            for (const run of runs) {
              const result = yield* legacy.discover(run.run_id, run.root_id);
              yield* legacy.cleanup(run.run_id, run.root_id, result.generation);
            }
            yield* settle();
          });
        let firstImportMs: number | null = null;
        let applyMs: number | null = null;
        if (directory) {
          const root = join(directory, "media");
          yield* Effect.promise(async () => {
            await mkdir(root);
            for (let offset = 0; offset < count; offset += 100)
              await Promise.all(
                Array.from({ length: Math.min(100, count - offset) }, (_, index) =>
                  writeFile(join(root, `${offset + index}.mp4`), "media"),
                ),
              );
          });
          const libraryId = crypto.randomUUID();
          yield* libraryService.create(
            { id: libraryId, name: "Benchmark", slug: libraryId, kind: "movies" },
            Date.now(),
          );
          yield* libraryService.addRoot(
            { id: crypto.randomUUID(), libraryId, path: root, priority: 0 },
            Date.now(),
          );
          if (!modern) yield* libraryWatcher.check(Date.now());
          const firstStarted = performance.now();
          if (modern) {
            const prepared = yield* scannerService.prepare(libraryId, {
              mode: "incremental",
              userInitiated: false,
            });
            if (prepared === null) throw new Error("Missing benchmark library");
            const applyStarted = performance.now();
            yield* scannerService.apply(prepared, Date.now());
            applyMs = performance.now() - applyStarted;
          } else {
            yield* libraryService.startScan({ libraryId, mode: "incremental" }, Date.now());
            yield* reconcileLegacy();
          }
          firstImportMs = performance.now() - firstStarted;
          // Complete synthetic ingest through its persisted public boundary.
          yield* db.run(sql`UPDATE media_sources SET content_fingerprint='benchmark'`);
          yield* db.run(
            sql`INSERT INTO catalog_items(id,library_id,kind,title,sort_title,added_at_ms,updated_at_ms) SELECT id,library_id,'movie',id,id,1,1 FROM media_sources`,
          );
          yield* db.run(
            sql`INSERT INTO catalog_item_sources(item_id,source_id,is_primary) SELECT id,id,1 FROM media_sources`,
          );
          yield* settle();
        }
        // Existing copies may contain work interrupted by the backup; settle only in the isolated copy.
        if (existing) yield* settle();
        const observer = new Sqlite(filename, { readonly: true });
        const samples: unknown[] = [];
        try {
          // Existing databases have NULL device until the first branch reconciliation; report that warm-up separately.
          for (let iteration = 0; iteration < 4; iteration++) {
            const before = observer.query("PRAGMA data_version").get();
            const runsBefore = observer.query("SELECT count(*) AS count FROM scan_runs").get();
            const begin = performance.now();
            const runsStarted = yield* libraryWatcher.check(Date.now());
            if (!modern) yield* reconcileLegacy();
            samples.push({
              iteration,
              elapsedMs: performance.now() - begin,
              runsStarted,
              dataVersionBefore: before,
              dataVersionAfter: observer.query("PRAGMA data_version").get(),
              runsBefore,
              runsAfter: observer.query("SELECT count(*) AS count FROM scan_runs").get(),
            });
            if (modern && existing && iteration === 0) yield* settle();
          }
          console.log(
            JSON.stringify(
              {
                implementation: modern ? "reconciler" : "baseline",
                syntheticFiles: directory ? count : null,
                startupMs,
                startup,
                firstImportMs,
                applyMs,
                samples,
              },
              null,
              2,
            ),
          );
        } finally {
          observer.close();
        }
      }).pipe(Effect.provide(layers)),
    ),
  );
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
