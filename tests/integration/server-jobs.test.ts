import { afterEach, describe, expect, test } from "bun:test";
import {
  Database,
  Repositories,
  RepositoriesLive,
  sql,
} from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { JobService, JobServiceLive } from "../../apps/server/src/jobs/JobService";
import { LibraryWatcher, LibraryWatcherLive } from "../../apps/server/src/jobs/LibraryWatcher";
import {
  ScheduledJobService,
  ScheduledJobServiceLive,
} from "../../apps/server/src/jobs/ScheduledJobService";
import { LibraryServiceLive } from "../../apps/server/src/services/LibraryService";
import { MetadataSettingsLive } from "../../apps/server/src/services/MetadataSettings";
import { Scanner, ScannerLive, scanRoot } from "../../apps/server/src/services/Scanner";

const paths: string[] = [];

afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("durable jobs and scanner reconciliation", () => {
  test("discovers Matroska files case-insensitively", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-scanner-test-"));
    paths.push(root);
    await Bun.write(join(root, "movie.MKV"), "matroska");

    const files = await Array.fromAsync(scanRoot(root));

    expect(files.map((file) => file.relativePath)).toEqual(["movie.MKV"]);
  });

  test("recovers expired leases and does not cross a root generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-job-test-"));
    paths.push(root);
    const databasePath = join(root, "server.sqlite");
    const databaseLayer = makeDatabaseLayers({ databasePath } as never);
    const repositories = RepositoriesLive(databaseLayer);
    const scanner = ScannerLive.pipe(Layer.provide(Layer.mergeAll(databaseLayer, repositories)));
    const metadataSettings = MetadataSettingsLive.pipe(Layer.provide(databaseLayer));
    const jobs = JobServiceLive.pipe(
      Layer.provide(Layer.mergeAll(databaseLayer, repositories, scanner, metadataSettings)),
    );
    const layer = Layer.mergeAll(databaseLayer, repositories, scanner, metadataSettings, jobs);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const repos = yield* Repositories;
        const scannerService = yield* Scanner;
        const jobsService = yield* JobService;
        const libraryId = newUuid();
        const rootId = newUuid();
        yield* database.run(
          sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Test', 'test', 1, 1, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, 1, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO library_root_states(root_id, library_id, canonical_path, canonical_key, is_available, scan_generation, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, ${root}, 1, 1, 1)`,
        );
        const run = yield* repos.scanning.startRun({
          runId: newUuid(),
          libraryId,
          mode: "full",
          startedAtMs: 1,
        });
        const job = yield* repos.scanning.createJob({
          id: newUuid(),
          runId: run.id,
          parentJobId: null,
          sourceId: null,
          dedupeKey: "discover:lease",
          operation: "discover",
          priority: 1,
          maxAttempts: 3,
          availableAtMs: 0,
        });
        const claimed = yield* repos.scanning.claimNextJob({
          workerId: "worker",
          nowMs: 0,
          operations: [],
        });
        const recovered = yield* jobsService.recover(400_000);
        const recoveredJob = yield* database.get<{ status: string; lockedAtMs: number | null }>(
          sql`SELECT status, locked_at_ms AS lockedAtMs FROM scan_jobs WHERE id = ${job.id}`,
        );
        const firstCount = yield* scannerService.discover(run.id, rootId);
        yield* Effect.promise(() => Bun.write(join(root, "ignored.txt"), "not media"));
        yield* database.run(
          sql`UPDATE library_root_states SET scan_generation = 2 WHERE root_id = ${rootId}`,
        );
        const secondCount = yield* scannerService.discover(run.id, rootId);
        return { recovered, recoveredJob, claimed, firstCount, secondCount };
      }).pipe(Effect.provide(layer)),
    );
    expect(result.recovered).toBeGreaterThan(0);
    expect(result.claimed?.status).toBe("running");
    expect(result.recoveredJob?.status).toBe("queued");
    expect(result.recoveredJob?.lockedAtMs).toBeNull();
    expect(result.firstCount).toBe(0);
    expect(result.secondCount).toBe(0);
  });

  test("schedules the library watcher and scans a library when a root modification time changes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lumen-watcher-test-"));
    paths.push(workspace);
    const root = join(workspace, "media");
    await mkdir(root);
    await utimes(root, new Date(1_000), new Date(1_000));
    const databaseLayer = makeDatabaseLayers({
      databasePath: join(workspace, "server.sqlite"),
    } as never);
    const repositories = RepositoriesLive(databaseLayer);
    const dependencies = Layer.mergeAll(databaseLayer, repositories);
    const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
    const watcher = LibraryWatcherLive.pipe(Layer.provide(Layer.mergeAll(dependencies, libraries)));
    const scheduler = ScheduledJobServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dependencies, watcher)),
    );
    const layer = Layer.mergeAll(dependencies, libraries, watcher, scheduler);
    const libraryId = newUuid();
    const rootId = newUuid();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const libraryWatcher = yield* LibraryWatcher;
        const scheduledJobs = yield* ScheduledJobService;
        yield* database.run(
          sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Movies', 'movies', 1, 1, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO library_profiles(library_id, kind, scan_mode) VALUES (${libraryId}, 'movies', 'full')`,
        );
        yield* database.run(
          sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, 1, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO library_root_states(root_id, library_id, canonical_path, canonical_key, is_available, scan_generation, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, ${root}, 1, 0, 1)`,
        );

        const firstSchedule = yield* scheduledJobs.runDue(1_000);
        const earlySchedule = yield* scheduledJobs.runDue(1_001);
        yield* Effect.promise(() => Bun.write(join(root, "new-movie.mkv"), "media"));
        const scansStarted = yield* libraryWatcher.check(2_000);
        const repeated = yield* libraryWatcher.check(2_001);
        yield* database.run(sql`
        UPDATE server_scheduled_jobs SET interval_ms = 86400000, next_run_at_ms = 86400000
        WHERE name = 'library-watcher'
      `);
        const afterIntervalChange = yield* scheduledJobs.runDue(2_000);
        const runs = yield* database.all<{ mode: string; status: string }>(
          sql`SELECT mode, status FROM scan_runs WHERE library_id = ${libraryId}`,
        );
        const jobs = yield* database.all<{ operation: string; dedupeKey: string }>(
          sql`SELECT operation, dedupe_key AS dedupeKey FROM scan_jobs`,
        );
        const schedule = yield* database.get<{
          nextRunAtMs: number;
          lastFinishedAtMs: number;
          lastError: string | null;
        }>(sql`
        SELECT next_run_at_ms AS nextRunAtMs, last_finished_at_ms AS lastFinishedAtMs, last_error AS lastError
        FROM server_scheduled_jobs WHERE name = 'library-watcher'
      `);
        return {
          firstSchedule,
          earlySchedule,
          scansStarted,
          repeated,
          afterIntervalChange,
          runs,
          jobs,
          schedule,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.firstSchedule).toBe(1);
    expect(result.earlySchedule).toBe(0);
    expect(result.scansStarted).toBe(1);
    expect(result.repeated).toBe(0);
    expect(result.afterIntervalChange).toBe(0);
    expect(result.runs).toEqual([{ mode: "incremental", status: "running" }]);
    expect(result.jobs).toEqual([{ operation: "discover", dedupeKey: `discover:${rootId}` }]);
    expect(result.schedule?.nextRunAtMs).toBe(62_000);
    expect(result.schedule?.lastFinishedAtMs).toBeGreaterThan(1_000);
    expect(result.schedule?.lastError).toBeNull();
  });

  test("defers a changed library while another scan is active", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lumen-watcher-active-test-"));
    paths.push(workspace);
    const root = join(workspace, "media");
    await mkdir(root);
    await utimes(root, new Date(1_000), new Date(1_000));
    const databaseLayer = makeDatabaseLayers({
      databasePath: join(workspace, "server.sqlite"),
    } as never);
    const repositories = RepositoriesLive(databaseLayer);
    const dependencies = Layer.mergeAll(databaseLayer, repositories);
    const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
    const watcher = LibraryWatcherLive.pipe(Layer.provide(Layer.mergeAll(dependencies, libraries)));
    const layer = Layer.mergeAll(dependencies, libraries, watcher);
    const libraryId = newUuid();
    const rootId = newUuid();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const repos = yield* Repositories;
        const libraryWatcher = yield* LibraryWatcher;
        yield* database.run(
          sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Movies', 'movies', 1, 1, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO library_profiles(library_id, kind, scan_mode) VALUES (${libraryId}, 'movies', 'full')`,
        );
        yield* database.run(
          sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, 1, 1)`,
        );
        yield* database.run(
          sql`INSERT INTO library_root_states(root_id, library_id, canonical_path, canonical_key, is_available, scan_generation, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, ${root}, 1, 0, 1)`,
        );
        yield* libraryWatcher.check(100);
        const active = yield* repos.scanning.startRun({
          runId: newUuid(),
          libraryId,
          mode: "full",
          startedAtMs: 150,
        });
        yield* Effect.promise(() => mkdir(join(root, "new-show")));
        const deferred = yield* libraryWatcher.check(200);
        yield* repos.scanning.finishRun({
          runId: active.id,
          status: "succeeded",
          nowMs: 250,
          errorCode: null,
          errorMessage: null,
        });
        const started = yield* libraryWatcher.check(300);
        const runCount = yield* database.get<{ count: number }>(
          sql`SELECT count(*) AS count FROM scan_runs WHERE library_id = ${libraryId}`,
        );
        return { deferred, started, runCount: runCount?.count ?? 0 };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.deferred).toBe(0);
    expect(result.started).toBe(1);
    expect(result.runCount).toBe(2);
  });
});
