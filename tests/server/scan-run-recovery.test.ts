import { afterEach, describe, expect, test } from "bun:test";
import {
  Database,
  type DatabaseClient,
  type DatabaseTransaction,
  Repositories,
  RepositoriesLive,
  scanJobs,
  scanRuns,
  sql,
} from "../../packages/database/src/index.ts";
import { Effect, Exit, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { JobService, JobServiceLive } from "../../apps/server/src/jobs/JobService";
import { LibraryWatcher, LibraryWatcherLive } from "../../apps/server/src/jobs/LibraryWatcher";
import { cleanupParkedAtMs, insertScanRun } from "../../apps/server/src/jobs/ScanJobs";
import { Ffprobe } from "../../apps/server/src/media/Ffprobe";
import { MediaIngestLive } from "../../apps/server/src/media/MediaIngest";
import { TmdbProvider } from "../../apps/server/src/media/Tmdb";
import { LibraryService, LibraryServiceLive } from "../../apps/server/src/services/LibraryService";
import { MetadataSettings } from "../../apps/server/src/services/MetadataSettings";
import { ScannerLive } from "../../apps/server/src/services/Scanner";

const leaseMs = 300_000;
// Discovery stamps probe jobs with the wall clock. Tests that run the scanner keep
// their own clock ahead of it so those jobs are always due.
const wallClockMs = () => Date.now() + 3_600_000;
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

const fakeFfprobe = Layer.succeed(Ffprobe, {
  probe: () =>
    Effect.succeed({
      durationMs: 60_000,
      streams: [
        {
          kind: "video" as const,
          ordinal: 0,
          codec: "h264",
          bitrate: null,
          sampleRateHz: null,
          channels: null,
          width: 1920,
          height: 1080,
          language: null,
          title: null,
          isDefault: true,
        },
      ],
      tags: {},
    }),
});

type Services = Database | Repositories | JobService | LibraryService | LibraryWatcher;

interface RunRow {
  readonly id: string;
  readonly mode: string;
  readonly status: string;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

interface JobRow {
  readonly id: string;
  readonly operation: string;
  readonly status: string;
  readonly attempts: number;
  readonly availableAtMs: number;
  readonly lockedAtMs: number | null;
  readonly lockedBy: string | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

interface JobSeed {
  readonly operation?: string;
  readonly status: string;
  readonly attempts?: number;
  readonly availableAtMs?: number;
  readonly lockedAtMs?: number;
  readonly sourceId?: string;
  readonly errorCode?: string;
}

const makeHarness = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lumen-scan-recovery-"));
  paths.push(workspace);
  // Metadata is stubbed: a test sets the key to enable enrichment and replaces
  // `enrich` to decide what an enrichment attempt does.
  const metadata = {
    tmdbKey: null as string | null,
    enrich: (_sourceId: string): Effect.Effect<void, unknown> => Effect.void,
    enriched: [] as string[],
  };
  // One-shot faults in the job worker's own writes.
  const faults = {
    beforeTransaction: null as Effect.Effect<unknown, unknown> | null,
    failWrite: null as ((kind: "insert" | "update", table: unknown) => boolean) | null,
  };
  const failingWrites = (transaction: DatabaseTransaction): DatabaseTransaction =>
    new Proxy(transaction, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (key !== "insert" && key !== "update")
          return typeof value === "function" ? value.bind(target) : value;
        return (table: unknown) => {
          if (faults.failWrite?.(key, table) === true) {
            faults.failWrite = null;
            throw new Error("Injected write failure");
          }
          return value.call(target, table);
        };
      },
    });
  const withFaults = (database: DatabaseClient): DatabaseClient =>
    new Proxy(database, {
      get: (target, key, receiver) =>
        key === "transaction"
          ? (run: (transaction: DatabaseTransaction) => Effect.Effect<unknown, unknown>) =>
              Effect.suspend(() => {
                const before = faults.beforeTransaction ?? Effect.void;
                faults.beforeTransaction = null;
                return before;
              }).pipe(
                Effect.andThen(
                  target.transaction((transaction) => run(failingWrites(transaction))),
                ),
              )
          : Reflect.get(target, key, receiver),
    });

  const database = makeDatabaseLayers({ databasePath: join(workspace, "server.sqlite") } as never);
  const dependencies = Layer.mergeAll(database, RepositoriesLive(database));
  const settings = Layer.succeed(MetadataSettings, {
    tmdbKey: () => Effect.sync(() => metadata.tmdbKey),
    setTmdbKey: () => Effect.void,
  });
  const tmdb = Layer.succeed(TmdbProvider, {
    episodeOrder: () => Effect.die("unused"),
    setEpisodeOrder: () => Effect.void,
    enrichSource: (sourceId) =>
      Effect.suspend(() => {
        metadata.enriched.push(sourceId);
        return metadata.enrich(sourceId);
      }),
  });
  const scanner = ScannerLive.pipe(Layer.provide(dependencies));
  const ingest = MediaIngestLive.pipe(Layer.provide(Layer.mergeAll(dependencies, fakeFfprobe)));
  const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
  const watcher = LibraryWatcherLive.pipe(Layer.provide(Layer.mergeAll(dependencies, libraries)));
  const jobs = JobServiceLive.pipe(
    Layer.provide(Layer.effect(Database, Effect.map(Database, withFaults))),
    Layer.provide(Layer.mergeAll(dependencies, scanner, ingest, settings, tmdb, watcher)),
  );
  const layer = Layer.mergeAll(dependencies, libraries, watcher, jobs);
  const run = <A>(effect: Effect.Effect<A, unknown, Services>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

  const createLibrary = async (kind: "movies" | "shows", rootCount = 1) => {
    const libraryId = newUuid();
    const roots: Array<{ readonly id: string; readonly path: string }> = [];
    for (let priority = 0; priority < rootCount; priority += 1) {
      const root = { id: newUuid(), path: join(workspace, `${kind}-${libraryId}-${priority}`) };
      await mkdir(root.path, { recursive: true });
      roots.push(root);
    }
    await run(
      Effect.gen(function* () {
        const service = yield* LibraryService;
        yield* service.create({ id: libraryId, name: kind, slug: `${kind}-${libraryId}`, kind }, 1);
        for (const [priority, root] of roots.entries())
          yield* service.addRoot({ id: root.id, libraryId, path: root.path, priority }, 1);
      }),
    );
    const file = async (relativePath: string, root = roots[0]) => {
      const path = join(root?.path ?? "", relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "media");
      return path;
    };
    return { libraryId, roots, file };
  };

  return { run, createLibrary, metadata, faults };
};

const all = <T>(statement: ReturnType<typeof sql>) =>
  Effect.flatMap(Database, (database) => database.all<T>(statement));

const runRows = (libraryId: string) =>
  all<RunRow>(sql`
    SELECT id, mode, status, started_at_ms AS startedAtMs, finished_at_ms AS finishedAtMs,
      error_code AS errorCode, error_message AS errorMessage
    FROM scan_runs WHERE library_id = ${libraryId} ORDER BY created_at_ms, id
  `);

const runRow = (runId: string) =>
  all<RunRow>(sql`
    SELECT id, mode, status, started_at_ms AS startedAtMs, finished_at_ms AS finishedAtMs,
      error_code AS errorCode, error_message AS errorMessage
    FROM scan_runs WHERE id = ${runId}
  `).pipe(Effect.map(([row]) => row));

const jobRows = (runId: string) =>
  all<JobRow>(sql`
    SELECT id, operation, status, attempts, available_at_ms AS availableAtMs,
      locked_at_ms AS lockedAtMs, locked_by AS lockedBy, started_at_ms AS startedAtMs,
      finished_at_ms AS finishedAtMs, error_code AS errorCode, error_message AS errorMessage
    FROM scan_jobs WHERE run_id = ${runId} ORDER BY operation, dedupe_key
  `);

/** Persists a running run and its jobs exactly as given, bypassing the worker. */
const seedRun = (libraryId: string, atMs: number, jobs: ReadonlyArray<JobSeed>) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const runId = newUuid();
    yield* database.run(sql`
      INSERT INTO scan_runs(id, library_id, mode, status, started_at_ms, created_at_ms)
      VALUES (${runId}, ${libraryId}, 'refresh', 'running', ${atMs}, ${atMs})
    `);
    for (const [index, job] of jobs.entries()) {
      const lockedAtMs = job.lockedAtMs ?? null;
      yield* database.run(sql`
        INSERT INTO scan_jobs(id, run_id, source_id, dedupe_key, operation, status, attempts,
          max_attempts, available_at_ms, locked_at_ms, locked_by, started_at_ms, error_code)
        VALUES (${newUuid()}, ${runId}, ${job.sourceId ?? null}, ${`seed:${index}`},
          ${job.operation ?? "metadata"}, ${job.status}, ${job.attempts ?? 0}, 3,
          ${job.availableAtMs ?? atMs}, ${lockedAtMs}, ${lockedAtMs === null ? null : "worker"},
          ${lockedAtMs}, ${job.errorCode ?? null})
      `);
    }
    return runId;
  });

/** Starts a metadata run through the worker's own run creation. */
const startMetadataRun = (libraryId: string, sourceIds: ReadonlyArray<string>, nowMs: number) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const runId = newUuid();
    yield* database.transaction((transaction) =>
      insertScanRun(
        transaction,
        {
          runId,
          libraryId,
          mode: "refresh",
          jobs: sourceIds.map((sourceId, index) => ({
            sourceId,
            dedupeKey: `metadata:test:${sourceId}`,
            operation: "metadata",
            priority: 900 - index,
            maxAttempts: 3,
          })),
        },
        nowMs,
      ),
    );
    return runId;
  });

/** Claims the next job as a worker that then dies without recording an outcome. */
const abandonNextJob = (nowMs: number) =>
  Effect.gen(function* () {
    const repositories = yield* Repositories;
    const job = yield* repositories.scanning.claimNextJob({
      workerId: `crashed-${nowMs}`,
      nowMs,
      operations: [],
    });
    if (job === null) throw new Error("Expected a job to claim");
    return job;
  });

/** Runs jobs until none is due, stepping past every retry backoff. */
const drain = (fromMs: number) =>
  Effect.gen(function* () {
    const worker = yield* JobService;
    let nowMs = fromMs;
    while (yield* worker.runOne(nowMs)) nowMs += 120_000;
    return nowMs;
  });

const scan = (libraryId: string, nowMs: number) =>
  Effect.gen(function* () {
    const libraries = yield* LibraryService;
    const { runId } = yield* libraries.startScan({ libraryId, mode: "full" }, nowMs);
    yield* drain(nowMs);
    return runId;
  });

const sourceIds = (libraryId: string) =>
  all<{ id: string }>(
    sql`SELECT id FROM media_sources WHERE library_id = ${libraryId} ORDER BY relative_path`,
  ).pipe(Effect.map((rows) => rows.map((row) => row.id)));

const activeRuns = all<{ id: string }>(
  sql`SELECT id FROM scan_runs WHERE status IN ('queued', 'running')`,
);

describe("scan job lease recovery", () => {
  test("an expired job with attempts left is requeued and its run stays active", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");

    const result = await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        const worker = yield* JobService;
        const { runId } = yield* libraries.startScan(
          { libraryId: movies.libraryId, mode: "full" },
          1_000,
        );
        yield* abandonNextJob(1_000);
        const withinLease = yield* worker.recover(1_000 + leaseMs);
        const recovered = yield* worker.recover(1_001 + leaseMs);
        return { withinLease, recovered, run: yield* runRow(runId), jobs: yield* jobRows(runId) };
      }),
    );

    expect(result.withinLease).toBe(0);
    expect(result.recovered).toBe(1);
    expect(result.run).toMatchObject({ status: "running", finishedAtMs: null });
    expect(result.jobs).toMatchObject([
      {
        operation: "discover",
        status: "queued",
        attempts: 1,
        availableAtMs: 1_001 + leaseMs,
        lockedAtMs: null,
        lockedBy: null,
        startedAtMs: null,
        finishedAtMs: null,
        errorCode: "LEASE_EXPIRED",
        errorMessage: "The worker stopped responding on attempt 1 of 3",
      },
    ]);
  });

  test("an exhausted expired job fails with its timestamps and fails its run", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const runId = yield* seedRun(movies.libraryId, 1_000, [{ status: "queued" }]);
        const states: Array<string | undefined> = [];
        let nowMs = 1_000;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          yield* abandonNextJob(nowMs);
          nowMs += leaseMs + 1;
          yield* worker.recover(nowMs);
          states.push((yield* runRow(runId))?.status);
        }
        const idle = yield* worker.runOne(nowMs);
        return { states, idle, nowMs, run: yield* runRow(runId), jobs: yield* jobRows(runId) };
      }),
    );

    expect(result.states).toEqual(["running", "running", "failed"]);
    expect(result.idle).toBe(false);
    expect(result.jobs).toMatchObject([
      {
        status: "failed",
        attempts: 3,
        lockedAtMs: null,
        lockedBy: null,
        startedAtMs: result.nowMs - leaseMs - 1,
        finishedAtMs: result.nowMs,
        errorCode: "LEASE_EXPIRED",
        errorMessage: "The worker stopped responding on attempt 3 of 3",
      },
    ]);
    expect(result.run).toMatchObject({
      status: "failed",
      startedAtMs: 1_000,
      finishedAtMs: result.nowMs,
      errorCode: "JOB_FAILED",
      errorMessage: "The worker stopped responding on attempt 3 of 3",
    });
  });

  test("a run stays active until its other jobs end, then reports the failure", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Arrival (2016)/Arrival (2016).mkv");
    await movies.file("Heat (1995)/Heat (1995).mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const database = yield* Database;
        const startedAtMs = wallClockMs();
        yield* scan(movies.libraryId, startedAtMs);
        const [first, second] = yield* sourceIds(movies.libraryId);
        if (first === undefined || second === undefined) throw new Error("Expected two sources");
        const runId = yield* startMetadataRun(movies.libraryId, [first, second], startedAtMs);
        yield* database.run(
          sql`UPDATE scan_jobs SET attempts = 2 WHERE run_id = ${runId} AND source_id = ${first}`,
        );
        // The first job's last attempt is abandoned; the second is being worked on.
        yield* abandonNextJob(startedAtMs);
        const running = yield* abandonNextJob(startedAtMs + leaseMs);
        yield* worker.recover(startedAtMs + leaseMs + 1);
        const whileRunning = yield* runRow(runId);
        // The second job's worker dies too; its retry is queued behind a backoff.
        yield* worker.recover(startedAtMs + 2 * leaseMs + 1);
        const whileQueued = yield* runRow(runId);
        yield* drain(startedAtMs + 2 * leaseMs + 2);
        return {
          running,
          whileRunning,
          whileQueued,
          run: yield* runRow(runId),
          jobs: yield* jobRows(runId),
        };
      }),
    );

    expect(result.whileRunning?.status).toBe("running");
    expect(result.whileQueued?.status).toBe("running");
    expect(result.jobs.map((job) => job.status).sort()).toEqual(["failed", "succeeded"]);
    expect(result.run).toMatchObject({ status: "failed", errorCode: "JOB_FAILED" });
    expect(harness.metadata.enriched).toEqual([result.running.sourceId ?? ""]);
  });

  test("recovery does not take back a job another worker has claimed again", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");

    const result = await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        const worker = yield* JobService;
        const database = yield* Database;
        const { runId } = yield* libraries.startScan(
          { libraryId: movies.libraryId, mode: "full" },
          1_000,
        );
        yield* abandonNextJob(1_000);
        // Between recovery selecting the expired claim and writing it back, another
        // process recovers the job and a second worker claims it.
        harness.faults.beforeTransaction = database.run(sql`
          UPDATE scan_jobs SET attempts = 2, locked_by = 'second-worker',
            locked_at_ms = ${leaseMs + 900}, started_at_ms = ${leaseMs + 900}
          WHERE run_id = ${runId}
        `);
        const recovered = yield* worker.recover(1_001 + leaseMs);
        return { recovered, run: yield* runRow(runId), jobs: yield* jobRows(runId) };
      }),
    );

    expect(result.recovered).toBe(0);
    expect(result.run?.status).toBe("running");
    expect(result.jobs).toMatchObject([
      { status: "running", attempts: 2, lockedBy: "second-worker", errorCode: null },
    ]);
  });

  test("a worker that lost its lease does not record its outcome", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Arrival (2016)/Arrival (2016).mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const database = yield* Database;
        const startedAtMs = wallClockMs();
        yield* scan(movies.libraryId, startedAtMs);
        const runId = yield* startMetadataRun(
          movies.libraryId,
          yield* sourceIds(movies.libraryId),
          startedAtMs,
        );
        // While the job runs, recovery hands it to a second worker.
        harness.metadata.enrich = () =>
          database.run(sql`
            UPDATE scan_jobs SET attempts = 2, locked_by = 'second-worker'
            WHERE run_id = ${runId}
          `);
        const ran = yield* worker.runOne(startedAtMs);
        return { ran, run: yield* runRow(runId), jobs: yield* jobRows(runId) };
      }),
    );

    expect(result.ran).toBe(true);
    expect(result.run?.status).toBe("running");
    expect(result.jobs).toMatchObject([
      { status: "running", attempts: 2, lockedBy: "second-worker", finishedAtMs: null },
    ]);
  });
});

describe("scan run reconciliation", () => {
  test("repairs a run left active with only failed jobs so scans can resume", async () => {
    const harness = await makeHarness();
    harness.metadata.tmdbKey = "key";
    const shows = await harness.createLibrary("shows");
    await shows.file("Re ZERO/Season 1/Re ZERO - S01E01.mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        const watcher = yield* LibraryWatcher;
        const worker = yield* JobService;
        const startedAtMs = wallClockMs();
        yield* scan(shows.libraryId, startedAtMs);
        yield* watcher.check(startedAtMs);
        const [existing] = yield* sourceIds(shows.libraryId);
        // The state production was found in: the job exhausted its attempts under
        // an earlier release, which failed it without ending its run.
        const stuckRunId = yield* seedRun(shows.libraryId, startedAtMs, [
          { status: "failed", attempts: 3, errorCode: "LEASE_EXPIRED", sourceId: existing },
        ]);
        yield* Effect.promise(() =>
          shows.file("The Office (US)/Season 1/The Office (US) - S01E01.mkv"),
        );

        const manualWhileStuck = yield* Effect.exit(
          libraries.startScan({ libraryId: shows.libraryId, mode: "full" }, startedAtMs + 1),
        );
        const watcherWhileStuck = yield* watcher.check(startedAtMs + 2);
        const idleWhileStuck = yield* worker.runOne(startedAtMs + 3);

        const recovered = yield* worker.recover(startedAtMs + 1_000);
        const repaired = yield* runRow(stuckRunId);
        const recoveredAgain = yield* worker.recover(startedAtMs + 2_000);
        const repairedAgain = yield* runRow(stuckRunId);

        const watcherAfterRepair = yield* watcher.check(startedAtMs + 3_000);
        const [watched] = yield* activeRuns;
        const drainedAtMs = yield* drain(startedAtMs + 3_001);
        const manualAfterRepair = yield* scan(shows.libraryId, drainedAtMs);
        return {
          manualWhileStuck,
          watcherWhileStuck,
          idleWhileStuck,
          recovered,
          repaired,
          recoveredAgain,
          repairedAgain,
          repairedAtMs: startedAtMs + 1_000,
          watcherAfterRepair,
          watched: watched === undefined ? undefined : yield* runRow(watched.id),
          manual: yield* runRow(manualAfterRepair),
          active: yield* activeRuns,
          sources: yield* all<{ relativePath: string }>(sql`
            SELECT relative_path AS relativePath FROM media_sources
            WHERE library_id = ${shows.libraryId} ORDER BY relative_path
          `),
          episodes: yield* all<{ count: number }>(sql`
            SELECT count(*) AS count FROM catalog_items
            WHERE library_id = ${shows.libraryId} AND kind = 'episode'
          `),
        };
      }),
    );

    expect(Exit.isFailure(result.manualWhileStuck)).toBe(true);
    expect(result.watcherWhileStuck).toBe(0);
    expect(result.idleWhileStuck).toBe(false);
    expect(result.recovered).toBe(0);
    expect(result.repaired).toMatchObject({
      status: "failed",
      finishedAtMs: result.repairedAtMs,
      errorCode: "JOB_FAILED",
      errorMessage: "LEASE_EXPIRED",
    });
    expect(result.recoveredAgain).toBe(0);
    expect(result.repairedAgain).toEqual(result.repaired);
    expect(result.watcherAfterRepair).toBe(1);
    expect(result.watched).toMatchObject({ mode: "incremental", status: "succeeded" });
    expect(result.manual).toMatchObject({ mode: "full", status: "succeeded" });
    expect(result.active).toEqual([]);
    expect(result.sources.map((source) => source.relativePath)).toEqual([
      "Re ZERO/Season 1/Re ZERO - S01E01.mkv",
      "The Office (US)/Season 1/The Office (US) - S01E01.mkv",
    ]);
    expect(result.episodes).toEqual([{ count: 2 }]);
  });

  test.each([
    [["succeeded"], "succeeded", null],
    [["succeeded", "cancelled"], "cancelled", null],
    [["succeeded", "cancelled", "failed"], "failed", "JOB_FAILED"],
    [[], "failed", "NO_JOBS"],
  ] as const)("a run whose jobs ended as %j is finished as %s", async (statuses, status, code) => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");

    const run = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const runId = yield* seedRun(
          movies.libraryId,
          1_000,
          statuses.map((jobStatus) => ({ status: jobStatus })),
        );
        yield* worker.recover(2_000);
        return yield* runRow(runId);
      }),
    );

    expect(run).toMatchObject({ status, errorCode: code, startedAtMs: 1_000, finishedAtMs: 2_000 });
  });

  test("leaves runs with queued, backed-off, or running jobs active", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const seeded = [
          yield* seedRun(movies.libraryId, 1_000, [{ status: "failed" }, { status: "queued" }]),
          yield* seedRun(movies.libraryId, 1_000, [
            { status: "failed" },
            { status: "queued", availableAtMs: 10 * leaseMs },
          ]),
          yield* seedRun(movies.libraryId, 1_000, [
            { status: "failed" },
            { status: "running", lockedAtMs: 1_000 },
          ]),
          // A discovery still to run keeps its sibling's cleanup parked.
          yield* seedRun(movies.libraryId, 1_000, [
            { status: "queued", operation: "discover", availableAtMs: 10 * leaseMs },
            { status: "queued", operation: "cleanup", availableAtMs: cleanupParkedAtMs },
          ]),
        ];
        const recovered = yield* worker.recover(1_000 + leaseMs);
        const runs = [];
        for (const runId of seeded) runs.push((yield* runRow(runId))?.status);
        const parked = yield* all<{ status: string; availableAtMs: number }>(sql`
          SELECT status, available_at_ms AS availableAtMs FROM scan_jobs
          WHERE operation = 'cleanup'
        `);
        return { recovered, runs, parked };
      }),
    );

    expect(result.recovered).toBe(0);
    expect(result.runs).toEqual(["running", "running", "running", "running"]);
    expect(result.parked).toEqual([{ status: "queued", availableAtMs: cleanupParkedAtMs }]);
  });

  test("a failed job outcome is retried, then ends the run with the job's error", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Arrival (2016)/Arrival (2016).mkv");
    harness.metadata.enrich = () => Effect.fail(new Error("TMDb responded 404"));

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const startedAtMs = wallClockMs();
        yield* scan(movies.libraryId, startedAtMs);
        const runId = yield* startMetadataRun(
          movies.libraryId,
          yield* sourceIds(movies.libraryId),
          startedAtMs,
        );
        const states = [];
        let nowMs = startedAtMs;
        while (yield* worker.runOne(nowMs)) {
          const [job] = yield* jobRows(runId);
          states.push([job?.status, job?.attempts, (yield* runRow(runId))?.status]);
          nowMs += 120_000;
        }
        return { states, run: yield* runRow(runId), jobs: yield* jobRows(runId) };
      }),
    );

    expect(result.states).toEqual([
      ["queued", 1, "running"],
      ["queued", 2, "running"],
      ["failed", 3, "failed"],
    ]);
    const [job] = result.jobs;
    expect(job).toMatchObject({ errorCode: "JOB_FAILED", errorMessage: "TMDb responded 404" });
    expect(job?.finishedAtMs).toBeGreaterThanOrEqual(job?.startedAtMs ?? Number.NaN);
    expect(result.run).toMatchObject({
      status: "failed",
      finishedAtMs: job?.finishedAtMs,
      errorCode: "JOB_FAILED",
      errorMessage: "TMDb responded 404",
    });
  });
});

describe("parked cleanup settlement", () => {
  const cleanups = (runId: string) =>
    jobRows(runId).pipe(
      Effect.map((jobs) => jobs.filter((job) => job.operation === "cleanup")),
      Effect.map((jobs) => jobs.map((job) => job.status)),
    );

  /** Scans a two-root library up to the point where only the second root's discovery is left. */
  const scanFirstRoot = (
    library: { readonly libraryId: string; readonly roots: ReadonlyArray<{ readonly id: string }> },
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const libraries = yield* LibraryService;
      const worker = yield* JobService;
      const database = yield* Database;
      const { runId } = yield* libraries.startScan(
        { libraryId: library.libraryId, mode: "full" },
        nowMs,
      );
      yield* database.run(sql`
        UPDATE scan_jobs SET priority = 1
        WHERE run_id = ${runId} AND dedupe_key = ${`discover:${library.roots[1]?.id}`}
      `);
      yield* worker.runOne(nowMs);
      yield* database.run(sql`
        UPDATE scan_jobs SET priority = 1000
        WHERE run_id = ${runId} AND dedupe_key = ${`discover:${library.roots[1]?.id}`}
      `);
      return runId;
    });

  const titles = (libraryId: string) =>
    all<{ relativePath: string }>(sql`
      SELECT relative_path AS relativePath FROM media_sources
      WHERE library_id = ${libraryId} ORDER BY relative_path
    `).pipe(Effect.map((rows) => rows.map((row) => row.relativePath)));

  test("a discovery whose leases all expire cancels cleanup and deletes nothing", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies", 2);
    const removed = await movies.file("Film (2020)/Film (2020).mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        let nowMs = wallClockMs();
        yield* scan(movies.libraryId, nowMs);
        yield* Effect.promise(() => rm(removed));
        const runId = yield* scanFirstRoot(movies, nowMs);
        const parked = yield* cleanups(runId);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const job = yield* abandonNextJob(nowMs);
          if (job.operation !== "discover") throw new Error("Expected the second discovery");
          nowMs += leaseMs + 1;
          yield* worker.recover(nowMs);
        }
        yield* drain(nowMs);
        return {
          parked,
          cleanups: yield* cleanups(runId),
          run: yield* runRow(runId),
          sources: yield* titles(movies.libraryId),
        };
      }),
    );

    expect(result.parked).toEqual(["queued"]);
    expect(result.cleanups).toEqual(["cancelled"]);
    expect(result.run).toMatchObject({ status: "failed", errorCode: "JOB_FAILED" });
    expect(result.sources).toEqual(["Film (2020)/Film (2020).mkv"]);
  });

  test("a discovery that succeeds after an expired lease releases every cleanup", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies", 2);
    const removed = await movies.file("Film (2020)/Film (2020).mkv");
    await movies.file("Kept (2021)/Kept (2021).mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const nowMs = wallClockMs();
        yield* scan(movies.libraryId, nowMs);
        yield* Effect.promise(() => rm(removed));
        const runId = yield* scanFirstRoot(movies, nowMs);
        const beforeRecovery = { run: yield* runRow(runId), cleanups: yield* cleanups(runId) };
        yield* abandonNextJob(nowMs);
        yield* worker.recover(nowMs + leaseMs + 1);
        yield* drain(nowMs + leaseMs + 2);
        return {
          beforeRecovery,
          cleanups: yield* cleanups(runId),
          run: yield* runRow(runId),
          sources: yield* titles(movies.libraryId),
        };
      }),
    );

    expect(result.beforeRecovery.cleanups).toEqual(["queued"]);
    expect(result.beforeRecovery.run?.status).toBe("running");
    expect(result.cleanups).toEqual(["succeeded", "succeeded"]);
    expect(result.run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(result.sources).toEqual(["Kept (2021)/Kept (2021).mkv"]);
  });

  test.each([
    ["succeeded", ["succeeded"], "succeeded", ["Kept (2021)/Kept (2021).mkv"]],
    [
      "failed",
      ["cancelled"],
      "failed",
      ["Film (2020)/Film (2020).mkv", "Kept (2021)/Kept (2021).mkv"],
    ],
  ] as const)(
    "a cleanup stranded behind a %s discovery is settled by reconciliation",
    async (discovery, cleanupStatuses, runStatus, sources) => {
      const harness = await makeHarness();
      const movies = await harness.createLibrary("movies");
      const removed = await movies.file("Film (2020)/Film (2020).mkv");
      await movies.file("Kept (2021)/Kept (2021).mkv");

      const result = await harness.run(
        Effect.gen(function* () {
          const libraries = yield* LibraryService;
          const worker = yield* JobService;
          const database = yield* Database;
          const nowMs = wallClockMs();
          yield* scan(movies.libraryId, nowMs);
          yield* Effect.promise(() => rm(removed));
          const { runId } = yield* libraries.startScan(
            { libraryId: movies.libraryId, mode: "full" },
            nowMs,
          );
          yield* worker.runOne(nowMs);
          // An earlier release could stop between ending a discovery and settling
          // the cleanups parked behind it.
          yield* database.run(sql`
            UPDATE scan_jobs SET status = ${discovery}
            WHERE run_id = ${runId} AND operation = 'discover'
          `);
          yield* database.run(sql`
            UPDATE scan_jobs SET available_at_ms = ${cleanupParkedAtMs}
            WHERE run_id = ${runId} AND operation = 'cleanup'
          `);
          yield* drain(nowMs);
          const stranded = { run: yield* runRow(runId), cleanups: yield* cleanups(runId) };
          yield* worker.recover(nowMs + 1);
          yield* drain(nowMs + 2);
          return {
            stranded,
            cleanups: yield* cleanups(runId),
            run: yield* runRow(runId),
            sources: yield* titles(movies.libraryId),
          };
        }),
      );

      expect(result.stranded.cleanups).toEqual(["queued"]);
      expect(result.stranded.run?.status).toBe("running");
      expect(result.cleanups).toEqual([...cleanupStatuses]);
      expect(result.run?.status).toBe(runStatus);
      expect(result.sources).toEqual([...sources]);
    },
  );
});

describe("atomic scan writes", () => {
  test("a metadata backfill that fails part-way leaves no run behind", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Arrival (2016)/Arrival (2016).mkv");
    await movies.file("Heat (1995)/Heat (1995).mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const worker = yield* JobService;
        const nowMs = wallClockMs();
        yield* scan(movies.libraryId, nowMs);
        harness.metadata.tmdbKey = "key";
        harness.faults.failWrite = (kind, table) => kind === "insert" && table === scanJobs;
        const failed = yield* Effect.exit(worker.queueMissingMetadata(nowMs));
        const afterFailure = (yield* runRows(movies.libraryId)).filter(
          (run) => run.mode === "refresh",
        );
        const recovered = yield* worker.recover(nowMs + 1);
        const queued = yield* worker.queueMissingMetadata(nowMs + 2);
        const [run] = (yield* runRows(movies.libraryId)).filter((row) => row.mode === "refresh");
        const jobs = run === undefined ? [] : yield* jobRows(run.id);
        yield* drain(nowMs + 3);
        return {
          failed,
          afterFailure,
          recovered,
          queued,
          jobs,
          run: run === undefined ? undefined : yield* runRow(run.id),
        };
      }),
    );

    expect(Exit.isFailure(result.failed)).toBe(true);
    expect(result.afterFailure).toEqual([]);
    expect(result.recovered).toBe(0);
    expect(result.queued).toBe(2);
    expect(result.jobs.map((job) => [job.operation, job.status])).toEqual([
      ["metadata", "queued"],
      ["metadata", "queued"],
    ]);
    expect(result.run?.status).toBe("succeeded");
    expect(harness.metadata.enriched).toHaveLength(2);
  });

  test("a probe whose enrichment run cannot be written is retried without a stray run", async () => {
    const harness = await makeHarness();
    harness.metadata.tmdbKey = "key";
    const movies = await harness.createLibrary("movies");
    await movies.file("Arrival (2016)/Arrival (2016).mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        const worker = yield* JobService;
        const nowMs = wallClockMs();
        const { runId } = yield* libraries.startScan(
          { libraryId: movies.libraryId, mode: "full" },
          nowMs,
        );
        yield* worker.runOne(nowMs);
        harness.faults.failWrite = (kind, table) => kind === "insert" && table === scanRuns;
        const crashed = yield* Effect.exit(worker.runOne(nowMs));
        const afterCrash = {
          runs: yield* runRows(movies.libraryId),
          probe: (yield* jobRows(runId)).find((job) => job.operation === "probe"),
        };
        yield* worker.recover(nowMs + leaseMs + 1);
        yield* drain(nowMs + leaseMs + 2);
        return { crashed, afterCrash, runs: yield* runRows(movies.libraryId) };
      }),
    );

    expect(Exit.isFailure(result.crashed)).toBe(true);
    expect(result.afterCrash.runs.map((run) => [run.mode, run.status])).toEqual([
      ["full", "running"],
    ]);
    expect(result.afterCrash.probe).toMatchObject({ status: "running", attempts: 1 });
    expect(result.runs.map((run) => [run.mode, run.status]).sort()).toEqual([
      ["full", "succeeded"],
      ["refresh", "succeeded"],
    ]);
    expect(harness.metadata.enriched).toHaveLength(1);
  });

  test("a crash while finishing a run's last job leaves that job to be recovered", async () => {
    const harness = await makeHarness();
    const movies = await harness.createLibrary("movies");
    await movies.file("Arrival (2016)/Arrival (2016).mkv");

    const result = await harness.run(
      Effect.gen(function* () {
        const libraries = yield* LibraryService;
        const worker = yield* JobService;
        const nowMs = wallClockMs();
        const { runId } = yield* libraries.startScan(
          { libraryId: movies.libraryId, mode: "full" },
          nowMs,
        );
        harness.faults.failWrite = (kind, table) => kind === "update" && table === scanRuns;
        const crashed = yield* Effect.exit(drain(nowMs));
        const afterCrash = { run: yield* runRow(runId), jobs: yield* jobRows(runId) };
        const reconciled = yield* worker.recover(nowMs + 1);
        const stillActive = yield* runRow(runId);
        yield* worker.recover(nowMs + 10 * leaseMs);
        yield* drain(nowMs + 10 * leaseMs + 1);
        return {
          crashed,
          afterCrash,
          reconciled,
          stillActive,
          run: yield* runRow(runId),
          jobs: yield* jobRows(runId),
        };
      }),
    );

    expect(Exit.isFailure(result.crashed)).toBe(true);
    expect(result.afterCrash.run?.status).toBe("running");
    expect(result.afterCrash.jobs.map((job) => job.status).sort()).toEqual([
      "running",
      "succeeded",
      "succeeded",
    ]);
    expect(result.reconciled).toBe(0);
    expect(result.stillActive?.status).toBe("running");
    expect(result.run?.status).toBe("succeeded");
    expect(result.jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });
});
