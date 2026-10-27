import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { openDatabase } from "./support/database";
import { latch } from "./support/proxy";
import { ScanWorker } from "./support/scan-worker";
import { expect, test } from "./support/server";

type Database = ReturnType<typeof openDatabase>;
function enqueue(
  db: Database,
  libraryId: string,
  operation: string,
  key: string,
  sourceId: string | null = null,
) {
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO scan_runs(id,library_id,mode,status,created_at_ms,started_at_ms) VALUES(?,?,'incremental','running',1,1)",
  ).run(runId, libraryId);
  db.prepare(
    "INSERT INTO scan_jobs(id,run_id,source_id,dedupe_key,operation,status,available_at_ms) VALUES(?,?,?,?,?,'queued',1)",
  ).run(jobId, runId, sourceId, key, operation);
  return { runId, jobId };
}
const job = (db: Database, id: string) =>
  db.prepare("SELECT status, attempts, locked_by FROM scan_jobs WHERE id=?").get(id);
function metadata(db: Database) {
  db.exec(
    "INSERT INTO metadata_provider_settings(provider,api_key,updated_at_ms) VALUES('tmdb','fixture-key',1)",
  );
}
async function drain(worker: ScanWorker, nowMs = Date.now() + 60000) {
  for (let i = 0; i < 30; i++) {
    const reply = await worker.call("run", nowMs + i * 1000);
    expect(reply.error).toBeUndefined();
    if (reply.result === false) return;
  }
  throw new Error("Scanner did not drain its work");
}

test("discovery rolls back source, availability and seen records when enqueueing its probe fails", async ({
  server,
  admin,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["First.mp4"]);
  await server.stop();
  await server.media(library.path, "Second.mp4");
  const db = openDatabase(server.databasePath);
  const worker = await ScanWorker.start(server);
  try {
    const run = enqueue(db, library.id, "discover", `discover:${library.rootId}`);
    db.exec(
      "CREATE TRIGGER reject_probe BEFORE INSERT ON scan_jobs WHEN NEW.operation='probe' BEGIN SELECT RAISE(ABORT,'probe write fault'); END",
    );
    expect((await worker.call("run")).error).toBeUndefined();
    expect(job(db, run.jobId)).toMatchObject({ status: "queued", attempts: 1 });
    expect(
      db.prepare("SELECT relative_path FROM media_sources ORDER BY relative_path").all(),
    ).toEqual([{ relative_path: "First.mp4" }]);
    expect(db.prepare("SELECT count(*) AS n FROM media_source_availability").get()).toEqual({
      n: 1,
    });
    expect(
      db
        .prepare("SELECT count(*) AS n FROM server_scan_seen WHERE run_id=? AND change='new'")
        .get(run.runId),
    ).toEqual({ n: 0 });
    db.exec("DROP TRIGGER reject_probe");
    await drain(worker);
    expect(job(db, run.jobId)).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM media_sources").get()).toEqual({ n: 2 });
  } finally {
    await worker.close();
    db.close();
  }
  await server.start();
  expect(
    (await server.items(admin.accessToken, library.id)).map((item) => item.title).sort(),
  ).toEqual(["First", "Second"]);
});

test("metadata backfill commits its run and jobs together and can retry after a storage failure", async ({
  server,
  admin,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await server.stop();
  const db = openDatabase(server.databasePath);
  const worker = await ScanWorker.start(server);
  try {
    metadata(db);
    const before = db.prepare("SELECT count(*) AS n FROM scan_runs").get();
    db.exec(
      "CREATE TRIGGER reject_metadata BEFORE INSERT ON scan_jobs WHEN NEW.operation='metadata' BEGIN SELECT RAISE(ABORT,'metadata write fault'); END",
    );
    expect((await worker.call("backfill")).error).toContain("metadata write fault");
    expect(db.prepare("SELECT count(*) AS n FROM scan_runs").get()).toEqual(before);
    expect(
      db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE operation='metadata'").get(),
    ).toEqual({ n: 0 });
    db.exec("DROP TRIGGER reject_metadata");
    expect((await worker.call("backfill")).result).toBe(1);
    expect((await worker.call("backfill")).result).toBe(0);
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM scan_jobs j JOIN scan_runs r ON r.id=j.run_id WHERE r.library_id=? AND j.operation='metadata' AND r.status='running'",
        )
        .get(library.id),
    ).toEqual({ n: 1 });
  } finally {
    await worker.close();
    db.close();
  }
});

for (const boundary of ["followup", "settlement"] as const)
  test(`a ${boundary} write failure cannot commit a job outcome without its run and recovery completes it`, async ({
    server,
    admin,
  }) => {
    const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
    await server.stop();
    const db = openDatabase(server.databasePath);
    const worker = await ScanWorker.start(server);
    try {
      const sourceId = String(db.prepare("SELECT id FROM media_sources").get()?.id);
      if (boundary === "followup") metadata(db);
      const run = enqueue(db, library.id, "probe", `probe:${sourceId}`, sourceId);
      const before = db.prepare("SELECT count(*) AS n FROM scan_runs").get();
      db.exec(
        boundary === "followup"
          ? "CREATE TRIGGER reject_outcome BEFORE INSERT ON scan_runs WHEN NEW.mode='refresh' BEGIN SELECT RAISE(ABORT,'outcome write fault'); END"
          : "CREATE TRIGGER reject_outcome BEFORE UPDATE ON scan_runs WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'outcome write fault'); END",
      );
      const now = Date.now();
      expect((await worker.call("run", now)).error).toContain("outcome write fault");
      expect(job(db, run.jobId)).toMatchObject({ status: "running", attempts: 1 });
      expect(db.prepare("SELECT status FROM scan_runs WHERE id=?").get(run.runId)).toEqual({
        status: "running",
      });
      expect(db.prepare("SELECT count(*) AS n FROM scan_runs").get()).toEqual(before);
      db.exec("DROP TRIGGER reject_outcome");
      expect((await worker.call("recover", now + 5000)).error).toBeUndefined();
      expect((await worker.call("run", now + 5000)).error).toBeUndefined();
      expect(job(db, run.jobId)).toMatchObject({ status: "succeeded", attempts: 2 });
      expect(db.prepare("SELECT status FROM scan_runs WHERE id=?").get(run.runId)).toEqual({
        status: "succeeded",
      });
      if (boundary === "followup")
        expect(
          db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE operation='metadata'").get(),
        ).toEqual({ n: 1 });
    } finally {
      await worker.close();
      db.close();
    }
    await server.start();
    expect(await server.items(admin.accessToken, library.id)).toHaveLength(1);
  });

test("two live worker processes cannot claim the same job", async ({ server, admin }) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await server.stop();
  const db = openDatabase(server.databasePath);
  const workers = await Promise.all([ScanWorker.start(server), ScanWorker.start(server)]);
  try {
    const run = enqueue(db, library.id, "discover", `discover:${library.rootId}`);
    const replies = await Promise.all(workers.map((worker) => worker.call("claim")));
    for (const reply of replies) expect(reply.error).toBeUndefined();
    expect(replies.filter((reply) => reply.result !== null)).toHaveLength(1);
    expect(job(db, run.jobId)).toMatchObject({ status: "running", attempts: 1 });
    const owner = String(job(db, run.jobId)?.locked_by);
    await workers[0]?.call("recover", Date.now());
    expect(job(db, run.jobId)?.locked_by).toBe(owner);
    await workers[1]?.call("recover", Date.now() + 5000);
    await drain(workers[0] as ScanWorker);
    expect(job(db, run.jobId)).toMatchObject({ status: "succeeded", attempts: 2 });
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    db.close();
  }
});

for (const fails of [false, true])
  test(`a stale worker cannot ${fails ? "fail" : "complete"} a metadata job after another worker takes its lease`, async ({
    server,
    admin,
  }) => {
    const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
    await server.stop();
    const captured = latch();
    const released = latch();
    const provider = createServer(async (_request, response) => {
      captured.release();
      await released.promise;
      response
        .writeHead(fails ? 401 : 200, { "content-type": "application/json" })
        .end(JSON.stringify({ results: [] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Provider did not listen");
    const db = openDatabase(server.databasePath);
    metadata(db);
    const worker = await ScanWorker.start(server, {
      LUMEN_E2E_TMDB_ORIGIN: `http://127.0.0.1:${address.port}`,
    });
    const successor = await ScanWorker.start(server);
    try {
      const sourceId = String(db.prepare("SELECT id FROM media_sources").get()?.id);
      const run = enqueue(db, library.id, "metadata", `metadata:${sourceId}`, sourceId);
      const now = Date.now();
      const pending = worker.call("run", now);
      await captured.promise;
      expect(job(db, run.jobId)).toMatchObject({ status: "running", attempts: 1 });
      await successor.call("recover", now + 5000);
      const claim = await successor.call("claim", now + 5000);
      expect(claim.error).toBeUndefined();
      const claimed = job(db, run.jobId);
      expect(claimed).toMatchObject({ status: "running", attempts: 2 });
      released.release();
      expect((await pending).error).toBeUndefined();
      expect(job(db, run.jobId)).toEqual(claimed);
      expect(db.prepare("SELECT status FROM scan_runs WHERE id=?").get(run.runId)).toEqual({
        status: "running",
      });
      await expect.poll(() => worker.log.join("")).toContain("job_lease_lost");
    } finally {
      released.release();
      await Promise.all([worker.close(), successor.close()]);
      db.close();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

for (const exhausted of [false, true])
  test(`cleanup cannot purge a moved source while another root's discovery ${exhausted ? "fails permanently" : "waits for retry"}`, async ({
    server,
    admin,
  }) => {
    const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
    const original = await server.items(admin.accessToken, library.id);
    const destination = join(server.root, "destination");
    await mkdir(destination);
    const rootId = crypto.randomUUID();
    await server.api(`/libraries/${library.id}/roots`, {
      token: admin.accessToken,
      body: { id: rootId, libraryId: library.id, path: destination, priority: 1 },
    });
    await server.stop();
    await rename(join(library.path, "Film.mp4"), join(destination, "Film.mp4"));
    await writeFile(join(library.path, "mounted.txt"), "The volume is mounted");
    const db = openDatabase(server.databasePath);
    const worker = await ScanWorker.start(server);
    try {
      const run = enqueue(db, library.id, "discover", `discover:${library.rootId}`);
      db.prepare("UPDATE scan_jobs SET priority=300 WHERE id=?").run(run.jobId);
      const secondJob = crypto.randomUUID();
      db.prepare(
        "INSERT INTO scan_jobs(id,run_id,dedupe_key,operation,status,available_at_ms,max_attempts) VALUES(?,?,?,'discover','queued',1,?)",
      ).run(secondJob, run.runId, `discover:${rootId}`, exhausted ? 1 : 3);
      const source = db.prepare("SELECT id,root_id FROM media_sources").get();
      db.exec(
        "CREATE TRIGGER reject_seen BEFORE INSERT ON server_scan_seen BEGIN SELECT RAISE(ABORT,'seen write fault'); END",
      );
      expect((await worker.call("run")).error).toBeUndefined();
      const cleanup = () =>
        db
          .prepare(
            "SELECT status,available_at_ms FROM scan_jobs WHERE run_id=? AND operation='cleanup'",
          )
          .get(run.runId);
      expect(cleanup()).toEqual({ status: "queued", available_at_ms: Number.MAX_SAFE_INTEGER });
      expect((await worker.call("run")).error).toBeUndefined();
      expect(job(db, secondJob)).toMatchObject({
        status: exhausted ? "failed" : "queued",
        attempts: 1,
      });
      expect((await worker.call("run")).result).toBe(false);
      expect(db.prepare("SELECT id,root_id FROM media_sources").get()).toEqual(source);
      expect(cleanup()?.status).toBe(exhausted ? "cancelled" : "queued");
      db.exec("DROP TRIGGER reject_seen");
      if (!exhausted) {
        await drain(worker);
        expect(job(db, secondJob)).toMatchObject({ status: "succeeded", attempts: 2 });
        expect(db.prepare("SELECT id,root_id FROM media_sources").get()).toEqual({
          id: source?.id,
          root_id: rootId,
        });
        expect(cleanup()?.status).toBe("succeeded");
      }
    } finally {
      await worker.close();
      db.close();
    }
    await server.start();
    expect(await server.items(admin.accessToken, library.id)).toEqual(original);
  });

test("an old cleanup cannot delete files discovered by a superseding scan generation", async ({
  server,
  admin,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["First.mp4"]);
  await server.stop();
  const db = openDatabase(server.databasePath);
  const worker = await ScanWorker.start(server);
  try {
    const old = enqueue(db, library.id, "discover", `discover:${library.rootId}`);
    expect((await worker.call("run")).error).toBeUndefined();
    expect(
      db
        .prepare("SELECT status FROM scan_jobs WHERE run_id=? AND operation='cleanup'")
        .get(old.runId),
    ).toEqual({ status: "queued" });
    await server.media(library.path, "Second.mp4");
    db.prepare(
      "UPDATE library_root_states SET scan_generation=scan_generation+1 WHERE root_id=?",
    ).run(library.rootId);
    const next = enqueue(db, library.id, "discover", `discover:${library.rootId}`);
    db.prepare("UPDATE scan_jobs SET priority=400 WHERE id=?").run(next.jobId);
    expect((await worker.call("run")).error).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM media_sources").get()).toEqual({ n: 2 });
    await drain(worker);
    expect(db.prepare("SELECT count(*) AS n FROM media_sources").get()).toEqual({ n: 2 });
    await expect.poll(() => worker.log.join("")).toContain('"reason":"superseded"');
    for (const runId of [old.runId, next.runId])
      expect(db.prepare("SELECT status FROM scan_runs WHERE id=?").get(runId)).toEqual({
        status: "succeeded",
      });
  } finally {
    await worker.close();
    db.close();
  }
  await server.start();
  expect(
    (await server.items(admin.accessToken, library.id)).map((item) => item.title).sort(),
  ).toEqual(["First", "Second"]);
});
