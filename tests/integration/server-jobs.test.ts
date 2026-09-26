import { afterEach, describe, expect, test } from "bun:test";
import {
  Database,
  type DatabaseClient,
  Repositories,
  RepositoriesLive,
  sql,
} from "../../packages/database/src/index.ts";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
} from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import type { ServerConfig } from "../../apps/server/src/config/Config";
import {
  JobService,
  JobServiceLive,
  JobServiceLiveWithConfig,
} from "../../apps/server/src/jobs/JobService";
import { LibraryWatcher, LibraryWatcherLive } from "../../apps/server/src/jobs/LibraryWatcher";
import {
  ScheduledJobService,
  ScheduledJobServiceLive,
} from "../../apps/server/src/jobs/ScheduledJobService";
import {
  LibraryService,
  LibraryServiceLive,
  makeLibraryService,
} from "../../apps/server/src/services/LibraryService";
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
    const libraries = LibraryServiceLive.pipe(
      Layer.provide(Layer.mergeAll(databaseLayer, repositories)),
    );
    const watcher = LibraryWatcherLive.pipe(
      Layer.provide(Layer.mergeAll(databaseLayer, repositories, libraries)),
    );
    const jobs = JobServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(databaseLayer, repositories, scanner, metadataSettings, watcher),
      ),
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

const makeWatcherWorkspace = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lumen-watcher-job-test-"));
  paths.push(workspace);
  const root = join(workspace, "media");
  await mkdir(root);
  await utimes(root, new Date(1_000), new Date(1_000));
  return { root, databasePath: join(workspace, "server.sqlite") };
};

const makeWatcherLayer = (
  databasePath: string,
  watcherOverride?: Layer.Layer<LibraryWatcher>,
  jobsConfig?: Partial<ServerConfig>,
  jobsDatabase?: (database: DatabaseClient) => DatabaseClient,
) => {
  const databaseLayer = makeDatabaseLayers({ databasePath } as never);
  const repositories = RepositoriesLive(databaseLayer);
  const dependencies = Layer.mergeAll(databaseLayer, repositories);
  const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
  const watcher =
    watcherOverride ??
    LibraryWatcherLive.pipe(Layer.provide(Layer.mergeAll(dependencies, libraries)));
  const scanner = ScannerLive.pipe(Layer.provide(dependencies));
  const metadataSettings = MetadataSettingsLive.pipe(Layer.provide(databaseLayer));
  const jobs = (
    jobsConfig === undefined ? JobServiceLive : JobServiceLiveWithConfig(jobsConfig as ServerConfig)
  ).pipe(
    Layer.provide(
      jobsDatabase === undefined
        ? Layer.empty
        : Layer.effect(Database, Effect.map(Database, jobsDatabase)),
    ),
    Layer.provide(Layer.mergeAll(dependencies, scanner, metadataSettings, watcher)),
  );
  const scheduler = ScheduledJobServiceLive.pipe(Layer.provide(dependencies));
  return Layer.mergeAll(dependencies, libraries, watcher, jobs, scheduler);
};

const insertWatchedLibrary = (root: string) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const libraryId = newUuid();
    const rootId = newUuid();
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
    return { libraryId, rootId };
  });

interface WatcherJobRow {
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextRunAtMs: number;
  readonly completedAtMs: number | null;
  readonly updatedAtMs: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

const listWatcherJobs = Effect.gen(function* () {
  const database = yield* Database;
  return yield* database.all<WatcherJobRow>(sql`
    SELECT state, attempts, max_attempts AS maxAttempts, next_run_at_ms AS nextRunAtMs,
      completed_at_ms AS completedAtMs, updated_at_ms AS updatedAtMs,
      last_error_code AS lastErrorCode,
      last_error_message AS lastErrorMessage
    FROM jobs WHERE kind = 'library-watcher' ORDER BY created_at_ms, id
  `);
});

const countWatchState = Effect.gen(function* () {
  const database = yield* Database;
  const row = yield* database.get<{ count: number }>(
    sql`SELECT count(*) AS count FROM server_library_watch_state`,
  );
  return row?.count ?? 0;
});

describe("library watcher background job", () => {
  test("a schedule tick enqueues the watcher without checking library roots", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scheduledJobs = yield* ScheduledJobService;
        yield* insertWatchedLibrary(root);
        const dispatched = yield* scheduledJobs.runDue(1_000);
        return { dispatched, watchState: yield* countWatchState, jobs: yield* listWatcherJobs };
      }).pipe(Effect.provide(makeWatcherLayer(databasePath))),
    );

    expect(result.dispatched).toBe(1);
    expect(result.watchState).toBe(0);
    expect(result.jobs).toEqual([
      {
        state: "pending",
        attempts: 0,
        maxAttempts: 3,
        nextRunAtMs: 1_000,
        completedAtMs: null,
        updatedAtMs: 1_000,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    ]);
  });

  test("the job worker runs the scheduled watcher and scans a library when a root modification time changes", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const scheduledJobs = yield* ScheduledJobService;
        const jobService = yield* JobService;
        const { libraryId, rootId } = yield* insertWatchedLibrary(root);

        const firstSchedule = yield* scheduledJobs.runDue(1_000);
        const earlySchedule = yield* scheduledJobs.runDue(1_001);
        const baselineRan = yield* jobService.runOne(1_002);
        const baselineRuns = yield* database.all(
          sql`SELECT id FROM scan_runs WHERE library_id = ${libraryId}`,
        );
        yield* Effect.promise(() => Bun.write(join(root, "new-movie.mkv"), "media"));
        const secondSchedule = yield* scheduledJobs.runDue(61_000);
        const changeRan = yield* jobService.runOne(61_001);
        yield* database.run(sql`
          UPDATE server_scheduled_jobs SET interval_ms = 86400000, next_run_at_ms = 86400000
          WHERE name = 'library-watcher'
        `);
        const afterIntervalChange = yield* scheduledJobs.runDue(62_000);
        const runs = yield* database.all<{ mode: string; status: string }>(
          sql`SELECT mode, status FROM scan_runs WHERE library_id = ${libraryId}`,
        );
        const jobs = yield* database.all<{ operation: string; dedupeKey: string }>(
          sql`SELECT operation, dedupe_key AS dedupeKey FROM scan_jobs`,
        );
        const schedule = yield* database.get<{ nextRunAtMs: number; lastError: string | null }>(
          sql`
            SELECT next_run_at_ms AS nextRunAtMs, last_error AS lastError
            FROM server_scheduled_jobs WHERE name = 'library-watcher'
          `,
        );
        return {
          rootId,
          firstSchedule,
          earlySchedule,
          baselineRan,
          baselineRuns,
          secondSchedule,
          changeRan,
          afterIntervalChange,
          runs,
          jobs,
          schedule,
          watcherJobs: yield* listWatcherJobs,
        };
      }).pipe(Effect.provide(makeWatcherLayer(databasePath))),
    );

    expect(result.firstSchedule).toBe(1);
    expect(result.earlySchedule).toBe(0);
    expect(result.baselineRan).toBe(true);
    expect(result.baselineRuns).toEqual([]);
    expect(result.secondSchedule).toBe(1);
    expect(result.changeRan).toBe(true);
    expect(result.afterIntervalChange).toBe(0);
    expect(result.runs).toEqual([{ mode: "incremental", status: "running" }]);
    expect(result.jobs).toEqual([
      { operation: "discover", dedupeKey: `discover:${result.rootId}` },
    ]);
    expect(result.schedule).toEqual({ nextRunAtMs: 122_000, lastError: null });
    expect(result.watcherJobs.map((job) => [job.state, job.attempts])).toEqual([
      ["succeeded", 1],
      ["succeeded", 1],
    ]);
    const [baseline, change] = result.watcherJobs.map((job) => job.completedAtMs ?? 0);
    expect(baseline).toBeGreaterThanOrEqual(1_002);
    expect(baseline).toBeLessThan(61_000);
    expect(change).toBeGreaterThanOrEqual(61_001);
  });
  test("an unfinished watcher absorbs later ticks from every server process", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();
    const tick = (nowMs: number) =>
      Effect.gen(function* () {
        const database = yield* Database;
        const scheduledJobs = yield* ScheduledJobService;
        // Another process may have claimed the schedule; make it due again.
        yield* database.run(sql`UPDATE server_scheduled_jobs SET next_run_at_ms = 0`);
        return yield* scheduledJobs.runDue(nowMs);
      });

    await Effect.runPromise(
      insertWatchedLibrary(root).pipe(Effect.provide(makeWatcherLayer(databasePath))),
    );
    const firstProcess = await Effect.runPromise(
      Effect.all([tick(1_000), tick(61_000), tick(121_000)]).pipe(
        Effect.provide(makeWatcherLayer(databasePath)),
      ),
    );
    const secondProcess = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const dispatched = yield* tick(181_000);
        const schedule = yield* database.get<{ lastError: string | null }>(
          sql`SELECT last_error AS lastError FROM server_scheduled_jobs`,
        );
        return { dispatched, schedule, jobs: yield* listWatcherJobs };
      }).pipe(Effect.provide(makeWatcherLayer(databasePath))),
    );

    expect(firstProcess).toEqual([1, 1, 1]);
    expect(secondProcess.dispatched).toBe(1);
    expect(secondProcess.schedule?.lastError).toBeNull();
    expect(secondProcess.jobs.map((job) => [job.state, job.nextRunAtMs])).toEqual([
      ["pending", 1_000],
    ]);
  });

  test("a failing watcher is retried with backoff from its failure time and then recorded as failed", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();
    // Each attempt takes real time, so backoff measured from the claim time would
    // make the retry due before its delay has passed.
    const slowFailingWatcher = Layer.succeed(LibraryWatcher, {
      check: () =>
        Effect.sleep(20).pipe(Effect.andThen(Effect.fail(new Error("Media share is offline")))),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scheduledJobs = yield* ScheduledJobService;
        const jobService = yield* JobService;
        yield* insertWatchedLibrary(root);
        yield* scheduledJobs.runDue(1_000);
        const attempts = [];
        let dueAtMs = 1_000;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const early = yield* jobService.runOne(dueAtMs - 1);
          const ran = yield* jobService.runOne(dueAtMs);
          const [job] = yield* listWatcherJobs;
          if (job === undefined) throw new Error("Missing watcher job");
          attempts.push({ dueAtMs, early, ran, job });
          dueAtMs = job.nextRunAtMs;
        }
        yield* scheduledJobs.runDue(61_000);
        return { attempts, afterNextTick: yield* listWatcherJobs };
      }).pipe(Effect.provide(makeWatcherLayer(databasePath, slowFailingWatcher))),
    );

    for (const { dueAtMs, early, ran, job } of result.attempts) {
      expect(early).toBe(false);
      expect(ran).toBe(true);
      expect(job.updatedAtMs - dueAtMs).toBeGreaterThanOrEqual(20);
      expect(job.lastErrorCode).toBe("JOB_FAILED");
      expect(job.lastErrorMessage).toBe("Media share is offline");
    }
    expect(
      result.attempts.map(({ job }) => [
        job.state,
        job.attempts,
        job.nextRunAtMs - job.updatedAtMs,
        job.completedAtMs === null ? null : job.completedAtMs - job.updatedAtMs,
      ]),
    ).toEqual([
      ["pending", 1, 2_000, null],
      ["pending", 2, 4_000, null],
      ["failed", 3, 0, 0],
    ]);
    expect(result.afterNextTick.map((job) => job.state)).toEqual(["failed", "pending"]);
  });

  test("a watcher abandoned by a crashed worker is recovered after its lease expires", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();
    const started = Effect.runSync(Deferred.make<void>());
    let checks = 0;
    const hangingOnceWatcher = Layer.succeed(LibraryWatcher, {
      check: () => {
        checks += 1;
        return checks === 1
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(0);
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scheduledJobs = yield* ScheduledJobService;
        const jobService = yield* JobService;
        yield* insertWatchedLibrary(root);
        yield* scheduledJobs.runDue(1_000);
        const crashedWorker = yield* Effect.forkChild(jobService.runOne(1_000));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(crashedWorker);
        const beforeLeaseExpiry = yield* jobService.recover(300_000);
        const duplicateTick = yield* scheduledJobs.runDue(61_000);
        const recovered = yield* jobService.recover(301_001);
        const recoveredJobs = yield* listWatcherJobs;
        const ran = yield* jobService.runOne(301_002);
        return {
          beforeLeaseExpiry,
          duplicateTick,
          recovered,
          recoveredJobs,
          ran,
          jobs: yield* listWatcherJobs,
        };
      }).pipe(Effect.provide(makeWatcherLayer(databasePath, hangingOnceWatcher))),
    );

    expect(result.beforeLeaseExpiry).toBe(0);
    expect(result.duplicateTick).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.recoveredJobs).toEqual([
      {
        state: "pending",
        attempts: 1,
        maxAttempts: 3,
        nextRunAtMs: 301_001,
        completedAtMs: null,
        updatedAtMs: 301_001,
        lastErrorCode: "LEASE_EXPIRED",
        lastErrorMessage: null,
      },
    ]);
    expect(result.ran).toBe(true);
    expect(result.jobs.map((job) => [job.state, job.attempts])).toEqual([["succeeded", 2]]);
  });

  test("a watcher that outlives its lease is stopped and retried", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();
    const hangingWatcher = Layer.succeed(LibraryWatcher, { check: () => Effect.never });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scheduledJobs = yield* ScheduledJobService;
        const jobService = yield* JobService;
        yield* insertWatchedLibrary(root);
        yield* scheduledJobs.runDue(1_000);
        const ran = yield* jobService.runOne(1_000);
        return { ran, jobs: yield* listWatcherJobs };
      }).pipe(Effect.provide(makeWatcherLayer(databasePath, hangingWatcher, { scanLeaseMs: 200 }))),
    );

    expect(result.ran).toBe(true);
    expect(
      result.jobs.map(({ nextRunAtMs, updatedAtMs, ...job }) => ({
        ...job,
        // The failure is recorded before the lease expires at 1_200.
        failedBeforeLeaseExpiry: updatedAtMs > 1_000 && updatedAtMs < 1_200,
        retryDelayMs: nextRunAtMs - updatedAtMs,
      })),
    ).toEqual([
      {
        state: "pending",
        attempts: 1,
        maxAttempts: 3,
        completedAtMs: null,
        lastErrorCode: "JOB_FAILED",
        lastErrorMessage: "Job exceeded its 200ms lease",
        failedBeforeLeaseExpiry: true,
        retryDelayMs: 2_000,
      },
    ]);
  });

  test("a watcher claimed slowly still stops before its persisted lease expires", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();
    const hangingWatcher = Layer.succeed(LibraryWatcher, { check: () => Effect.never });
    const leaseMs = 400;
    const claimDelayMs = 200;
    // Stands in for connection contention: the claim transaction starts late, after
    // the lease clock has already started.
    const slowTransactions = (database: DatabaseClient) =>
      new Proxy(database, {
        get: (target, key, receiver) =>
          key === "transaction"
            ? (...args: Parameters<DatabaseClient["transaction"]>) =>
                Effect.sleep(claimDelayMs).pipe(Effect.andThen(target.transaction(...args)))
            : Reflect.get(target, key, receiver),
      });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scheduledJobs = yield* ScheduledJobService;
        const jobService = yield* JobService;
        yield* insertWatchedLibrary(root);
        yield* scheduledJobs.runDue(1_000);
        const startedAt = performance.now();
        const ran = yield* jobService.runOne(1_000);
        const elapsedMs = performance.now() - startedAt;
        const recovered = yield* jobService.recover(1_000 + leaseMs + 1);
        return { ran, elapsedMs, recovered, jobs: yield* listWatcherJobs };
      }).pipe(
        Effect.provide(
          makeWatcherLayer(
            databasePath,
            hangingWatcher,
            { scanLeaseMs: leaseMs },
            slowTransactions,
          ),
        ),
      ),
    );

    expect(result.ran).toBe(true);
    // The claim really waited, and the run still ended within the lease that
    // started before the claim.
    expect(result.elapsedMs).toBeGreaterThanOrEqual(claimDelayMs);
    expect(result.elapsedMs).toBeLessThan(leaseMs);
    expect(result.recovered).toBe(0);
    expect(
      result.jobs.map((job) => [
        job.state,
        job.lastErrorMessage,
        job.updatedAtMs < 1_000 + leaseMs,
      ]),
    ).toEqual([["pending", `Job exceeded its ${leaseMs}ms lease`, true]]);
  });

  test("a scan started while the watcher is deciding defers the library instead of failing", async () => {
    const { root, databasePath } = await makeWatcherWorkspace();
    const databaseLayer = makeDatabaseLayers({ databasePath } as never);
    const dependencies = Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer));
    const racingLibraries = Layer.effect(
      LibraryService,
      Effect.map(makeLibraryService, (live) => ({
        ...live,
        startWatchedScan: (input, roots, nowMs) =>
          live
            .startScan(input, nowMs)
            .pipe(Effect.andThen(live.startWatchedScan(input, roots, nowMs))),
      })),
    ).pipe(Layer.provide(dependencies));
    const watcher = LibraryWatcherLive.pipe(
      Layer.provide(Layer.mergeAll(dependencies, racingLibraries)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const libraryWatcher = yield* LibraryWatcher;
        const { libraryId } = yield* insertWatchedLibrary(root);
        yield* libraryWatcher.check(100);
        yield* Effect.promise(() => mkdir(join(root, "new-show")));
        const scansStarted = yield* libraryWatcher.check(200);
        const runs = yield* database.all(
          sql`SELECT id FROM scan_runs WHERE library_id = ${libraryId}`,
        );
        return { scansStarted, runCount: runs.length };
      }).pipe(Effect.provide(Layer.mergeAll(dependencies, watcher))),
    );

    expect(result.scansStarted).toBe(0);
    expect(result.runCount).toBe(1);
  });
});
