import { afterEach, describe, expect, test } from "bun:test";
import { Database, Repositories, RepositoriesLive, sql } from "../../packages/database/src/index.ts";
import { Effect, Layer } from "../../packages/database/node_modules/effect/dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid } from "../../apps/server/src/core/Security";
import { makeDatabaseLayers } from "../../apps/server/src/database/DatabaseLayer";
import { JobService, JobServiceLive } from "../../apps/server/src/jobs/JobService";
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
    const jobs = JobServiceLive.pipe(Layer.provide(Layer.mergeAll(databaseLayer, repositories, scanner, metadataSettings)));
    const layer = Layer.mergeAll(databaseLayer, repositories, scanner, metadataSettings, jobs);
    const result = await Effect.runPromise(Effect.gen(function* () {
      const database = yield* Database;
      const repos = yield* Repositories;
      const scannerService = yield* Scanner;
      const jobsService = yield* JobService;
      const libraryId = newUuid();
      const rootId = newUuid();
      yield* database.run(sql`INSERT INTO libraries(id, name, slug, is_enabled, created_at_ms, updated_at_ms) VALUES (${libraryId}, 'Test', 'test', 1, 1, 1)`);
      yield* database.run(sql`INSERT INTO library_roots(id, library_id, path, is_enabled, priority, created_at_ms, updated_at_ms) VALUES (${rootId}, ${libraryId}, ${root}, 1, 0, 1, 1)`);
      yield* database.run(sql`INSERT INTO server_scan_state(root_id, generation, updated_at_ms) VALUES (${rootId}, 1, 1)`);
      const run = yield* repos.scanning.startRun({ runId: newUuid(), libraryId, mode: "full", startedAtMs: 1 });
      const job = yield* repos.scanning.createJob({ id: newUuid(), runId: run.id, parentJobId: null, sourceId: null, dedupeKey: "discover:lease", operation: "discover", priority: 1, maxAttempts: 3, availableAtMs: 0 });
      const claimed = yield* repos.scanning.claimNextJob({ workerId: "worker", nowMs: 0, operations: [] });
      const recovered = yield* jobsService.recover(400_000);
      const recoveredJob = yield* database.get<{ status: string; lockedAtMs: number | null }>(sql`SELECT status, locked_at_ms AS lockedAtMs FROM scan_jobs WHERE id = ${job.id}`);
      const firstCount = yield* scannerService.discover(run.id, rootId);
      yield* Effect.promise(() => Bun.write(join(root, "ignored.txt"), "not media"));
      yield* database.run(sql`UPDATE server_scan_state SET generation = 2 WHERE root_id = ${rootId}`);
      const secondCount = yield* scannerService.discover(run.id, rootId);
      return { recovered, recoveredJob, claimed, firstCount, secondCount };
    }).pipe(Effect.provide(layer)));
    expect(result.recovered).toBeGreaterThan(0);
    expect(result.claimed?.status).toBe("running");
    expect(result.recoveredJob?.status).toBe("queued");
    expect(result.recoveredJob?.lockedAtMs).toBeNull();
    expect(result.firstCount).toBe(0);
    expect(result.secondCount).toBe(0);
  });
});
