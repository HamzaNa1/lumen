import { afterEach, describe, expect, test } from "bun:test";
import {
  Database,
  Repositories,
  RepositoriesLive,
  sql,
} from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdir, mkdtemp, rename, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { Ffprobe } from "../../apps/server/src/media/Ffprobe";
import { MediaIngest, MediaIngestLive } from "../../apps/server/src/media/MediaIngest";
import { ScanService, ScanServiceLive } from "../../apps/server/src/services/ScanService";
import { Scanner, ScannerLive } from "../../apps/server/src/services/Scanner";

type Mode = "full" | "incremental";

interface RunReport {
  readonly mode: string;
  readonly stats: {
    readonly discovered: number;
    readonly new: number;
    readonly changed: number;
    readonly moved: number;
    readonly unchanged: number;
    readonly skipped: number;
    readonly missing: number;
    readonly probesEnqueued: number;
  };
  readonly probed: ReadonlyArray<string>;
}

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

const makeLibrary = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lumen-incremental-scan-test-"));
  paths.push(workspace);
  const root = join(workspace, "media");
  await mkdir(root);
  const databaseLayer = makeDatabaseLayers({
    databasePath: join(workspace, "server.sqlite"),
  } as never);
  const repositories = RepositoriesLive(databaseLayer);
  const dependencies = Layer.mergeAll(databaseLayer, repositories);
  const layer = Layer.mergeAll(
    dependencies,
    ScannerLive.pipe(Layer.provide(dependencies)),
    ScanServiceLive.pipe(Layer.provide(dependencies)),
    MediaIngestLive.pipe(Layer.provide(Layer.mergeAll(dependencies, fakeFfprobe))),
  );
  const libraryId = newUuid();
  const rootId = newUuid();

  const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);
  const provided = <A>(
    effect: Effect.Effect<
      A,
      unknown,
      Database | Repositories | Scanner | ScanService | MediaIngest
    >,
  ) => run(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>);

  await provided(
    Effect.gen(function* () {
      const database = yield* Database;
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
    }),
  );

  const write = async (relativePath: string, content: string, modifiedAtMs = 1_000_000) => {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, content);
    await utimes(path, new Date(modifiedAtMs), new Date(modifiedAtMs));
  };

  /**
   * Runs discovery and cleanup for the root, then ingests every probe job the run enqueued.
   * Passing `ingest: false` leaves the probes unprocessed, as if they had failed.
   */
  const scan = (mode: Mode, options: { readonly ingest?: boolean } = {}) =>
    provided(
      Effect.gen(function* () {
        const repos = yield* Repositories;
        const scanner = yield* Scanner;
        const scans = yield* ScanService;
        const ingest = yield* MediaIngest;
        const database = yield* Database;
        const started = yield* repos.scanning.startRun({
          runId: newUuid(),
          libraryId,
          mode,
          startedAtMs: Date.now(),
        });
        yield* scanner.discover(started.id, rootId);
        yield* scanner.cleanup(started.id, rootId);
        const jobs = (yield* scans.listJobs(started.id)) as ReadonlyArray<{
          operation: string;
          sourceId: string | null;
        }>;
        const probed: string[] = [];
        for (const job of jobs) {
          if (job.operation !== "probe" || job.sourceId === null) continue;
          if (options.ingest !== false) yield* ingest.ingest(job.sourceId);
          const source = yield* database.get<{ relativePath: string }>(
            sql`SELECT relative_path AS relativePath FROM media_sources WHERE id = ${job.sourceId}`,
          );
          probed.push(source?.relativePath ?? "");
        }
        const report = (yield* scans.getRun(started.id)) as Omit<RunReport, "probed">;
        return { mode: report.mode, stats: report.stats, probed: probed.sort() } as RunReport;
      }),
    );

  return { root, rootId, libraryId, write, scan, provided };
};

describe("incremental library scans", () => {
  test("probes a new media file once and reports it as new", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");

    const report = await library.scan("incremental");

    expect(report.probed).toEqual(["Arrival (2016).mkv"]);
    expect(report.stats).toEqual({
      discovered: 1,
      new: 1,
      changed: 0,
      moved: 0,
      unchanged: 0,
      skipped: 0,
      missing: 0,
      probesEnqueued: 1,
    });
  });

  test("skips unchanged media without probing it again", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");
    await library.write("Heat (1995).mkv", "heat");
    await library.scan("full");

    const report = await library.scan("incremental");

    expect(report.mode).toBe("incremental");
    expect(report.probed).toEqual([]);
    expect(report.stats).toEqual({
      discovered: 2,
      new: 0,
      changed: 0,
      moved: 0,
      unchanged: 2,
      skipped: 2,
      missing: 0,
      probesEnqueued: 0,
    });
  });

  test("probes media whose size or modification time changed", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");
    await library.write("Heat (1995).mkv", "heat");
    await library.write("Ronin (1998).mkv", "ronin");
    await library.scan("full");
    await library.write("Arrival (2016).mkv", "arrival, extended cut");
    await library.write("Heat (1995).mkv", "heat", 2_000_000);

    const report = await library.scan("incremental");

    expect(report.probed).toEqual(["Arrival (2016).mkv", "Heat (1995).mkv"]);
    expect(report.stats).toEqual({
      discovered: 3,
      new: 0,
      changed: 2,
      moved: 0,
      unchanged: 1,
      skipped: 1,
      missing: 0,
      probesEnqueued: 2,
    });
  });

  test("treats a file replaced at an existing path as changed", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");
    await library.scan("full");
    await library.write("replacement.tmp", "ARRIVAL");
    await rename(join(library.root, "replacement.tmp"), join(library.root, "Arrival (2016).mkv"));

    const report = await library.scan("incremental");

    expect(report.probed).toEqual(["Arrival (2016).mkv"]);
    expect(report.stats.changed).toBe(1);
    expect(report.stats.probesEnqueued).toBe(1);
  });

  test("follows an unchanged moved file without probing it again", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");
    await library.scan("full");
    await mkdir(join(library.root, "Arrival (2016)"));
    await rename(
      join(library.root, "Arrival (2016).mkv"),
      join(library.root, "Arrival (2016)", "Arrival (2016).mkv"),
    );

    const moved = await library.scan("incremental");
    const after = await library.scan("incremental");

    expect(moved.probed).toEqual([]);
    expect(moved.stats).toEqual({
      discovered: 1,
      new: 0,
      changed: 0,
      moved: 1,
      unchanged: 0,
      skipped: 1,
      missing: 0,
      probesEnqueued: 0,
    });
    expect(after.stats.unchanged).toBe(1);
    expect(after.stats.moved).toBe(0);
    expect(after.stats.missing).toBe(0);
  });

  test("still detects removed media during an incremental scan", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");
    await library.write("Heat (1995).mkv", "heat");
    await library.scan("full");
    await rm(join(library.root, "Heat (1995).mkv"));

    const report = await library.scan("incremental");

    expect(report.probed).toEqual([]);
    expect(report.stats).toEqual({
      discovered: 1,
      new: 0,
      changed: 0,
      moved: 0,
      unchanged: 1,
      skipped: 1,
      missing: 1,
      probesEnqueued: 0,
    });
  });

  test("repairs an unchanged source whose earlier probe never completed", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");
    await library.write("Heat (1995).mkv", "heat");
    await library.scan("full");
    await library.write("Ronin (1998).mkv", "ronin");
    await library.scan("incremental", { ingest: false });

    const repaired = await library.scan("incremental");
    const after = await library.scan("incremental");

    expect(repaired.probed).toEqual(["Ronin (1998).mkv"]);
    expect(repaired.stats.unchanged).toBe(3);
    expect(repaired.stats.probesEnqueued).toBe(1);
    expect(after.probed).toEqual([]);
  });

  test("a full scan probes every discovered file", async () => {
    const library = await makeLibrary();
    await library.write("Arrival (2016).mkv", "arrival");
    await library.write("Heat (1995).mkv", "heat");
    await library.scan("full");

    const report = await library.scan("full");

    expect(report.probed).toEqual(["Arrival (2016).mkv", "Heat (1995).mkv"]);
    expect(report.stats).toEqual({
      discovered: 2,
      new: 0,
      changed: 0,
      moved: 0,
      unchanged: 2,
      skipped: 0,
      missing: 0,
      probesEnqueued: 2,
    });
  });
});
