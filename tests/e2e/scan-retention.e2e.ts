import { openDatabase } from "./support/database";
import { ScanWorker } from "./support/scan-worker";
import { expect, test } from "./support/server";

type Database = ReturnType<typeof openDatabase>;
const day = 86_400_000;
const count = (db: Database, table: string, runId: string) =>
  db.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id=?`).get(runId)?.n;
const run = (db: Database, id: string) =>
  db.prepare("SELECT stats_json,jobs_pruned_at_ms FROM scan_runs WHERE id=?").get(id);

function history(
  db: Database,
  libraryId: string,
  sourceId: string,
  finishedAt: number,
  status = "succeeded",
) {
  const id = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO scan_runs(id,library_id,mode,status,created_at_ms,started_at_ms,finished_at_ms) VALUES(?,?,'incremental',?,1,1,?)",
  ).run(id, libraryId, status, status === "running" ? null : finishedAt);
  db.prepare("UPDATE scan_runs SET stats_json=? WHERE id=?").run(
    JSON.stringify({
      discovered: 1,
      new: 0,
      changed: 0,
      moved: 0,
      unchanged: 1,
      skipped: 0,
      missing: 1,
      probesEnqueued: 1,
    }),
    id,
  );
  for (const [jobId, parent, operation] of [
    [parentId, null, "discover"],
    [crypto.randomUUID(), parentId, "probe"],
  ] as const) {
    db.prepare(
      "INSERT INTO scan_jobs(id,run_id,parent_job_id,source_id,dedupe_key,operation,status,available_at_ms,started_at_ms,finished_at_ms) VALUES(?,?,?,?,?,?,'succeeded',1,1,?)",
    ).run(jobId, id, parent, sourceId, jobId, operation, finishedAt);
  }
  return id;
}

async function maintain(worker: ScanWorker, db: Database, now: number) {
  db.exec("UPDATE server_scheduled_jobs SET next_run_at_ms=0 WHERE name='scan-history-retention'");
  expect((await worker.call("maintain", now)).error).toBeUndefined();
}

test("completed scan statistics survive source deletion", async ({ server, admin }) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4"]);
  const before = await server.scan(token, library.id);
  expect(before.stats).toMatchObject({ discovered: 1, unchanged: 1, skipped: 1 });
  await server.stop();
  const db = openDatabase(server.databasePath);
  const id = String(before.id);
  const worker = await ScanWorker.start(server);
  try {
    expect(JSON.parse(String(run(db, id)?.stats_json))).toEqual(before.stats);
    await maintain(worker, db, Date.now());
    db.exec("PRAGMA foreign_keys=ON; DELETE FROM media_sources");
    expect(JSON.parse(String(run(db, id)?.stats_json))).toEqual(before.stats);
  } finally {
    await worker.close();
    db.close();
  }
  await server.start();
  const after = await server.api<{ stats: unknown }>(`/scans/${id}`, { token });
  expect(after.stats).toEqual(before.stats);
});

test("retention preserves summaries, applies terminal-time cutoffs, and protects active work", async ({
  server,
  admin,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await server.stop();
  const db = openDatabase(server.databasePath);
  const now = Date.now();
  const sourceId = String(db.prepare("SELECT id FROM media_sources LIMIT 1").get()?.id);
  const old = history(db, library.id, sourceId, now - 30 * day);
  const aged = history(db, library.id, sourceId, now - 7 * day, "failed");
  const recent = history(db, library.id, sourceId, now - 7 * day + 1);
  const active = history(db, library.id, sourceId, now - 40 * day, "running");
  const inconsistent = history(db, library.id, sourceId, now - 40 * day);
  db.prepare(
    "UPDATE scan_jobs SET status='queued',started_at_ms=NULL,finished_at_ms=NULL WHERE run_id=? AND operation='probe'",
  ).run(inconsistent);
  const worker = await ScanWorker.start(server);
  try {
    await maintain(worker, db, now);
    expect(run(db, old)).toBeUndefined();
    expect(count(db, "scan_jobs", aged)).toBe(0);
    expect(count(db, "scan_jobs", recent)).toBe(2);
    expect(JSON.parse(String(run(db, aged)?.stats_json))).toEqual({
      discovered: 1,
      new: 0,
      changed: 0,
      moved: 0,
      unchanged: 1,
      skipped: 0,
      missing: 1,
      probesEnqueued: 1,
    });
    for (const id of [active, inconsistent]) {
      expect(run(db, id)?.jobs_pruned_at_ms).toBeNull();
      expect(count(db, "scan_jobs", id)).toBe(2);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    await worker.close();
    db.close();
  }
});

test("job retention deletes children in bounded batches before their parent", async ({
  server,
  admin,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await server.stop();
  const db = openDatabase(server.databasePath);
  const now = Date.now();
  const sourceId = String(db.prepare("SELECT id FROM media_sources LIMIT 1").get()?.id);
  const id = history(db, library.id, sourceId, now - 8 * day);
  const parentId = String(
    db.prepare("SELECT id FROM scan_jobs WHERE run_id=? AND operation='discover'").get(id)?.id,
  );
  const add = db.prepare(
    "INSERT INTO scan_jobs(id,run_id,parent_job_id,dedupe_key,operation,status,available_at_ms,started_at_ms,finished_at_ms) VALUES(?,?,?,?,'metadata','succeeded',1,1,?)",
  );
  for (let i = 0; i < 449; i++) {
    const jobId = crypto.randomUUID();
    add.run(jobId, id, parentId, jobId, now - 8 * day);
  }
  db.exec(`CREATE TRIGGER interrupt_job_cleanup BEFORE DELETE ON scan_jobs
    WHEN OLD.run_id='${id}' AND (SELECT count(*) FROM scan_jobs WHERE run_id=OLD.run_id)<=251
    BEGIN SELECT RAISE(ABORT,'injected job cleanup interruption'); END`);
  const worker = await ScanWorker.start(server);
  try {
    await maintain(worker, db, now);
    expect(count(db, "scan_jobs", id)).toBe(251);
    expect(db.prepare("SELECT id FROM scan_jobs WHERE id=?").get(parentId)).toBeDefined();
    expect(run(db, id)?.jobs_pruned_at_ms).toBeNull();
    db.exec("DROP TRIGGER interrupt_job_cleanup");
    await maintain(worker, db, now + 60_000);
    expect(count(db, "scan_jobs", id)).toBe(0);
    expect(run(db, id)?.jobs_pruned_at_ms).not.toBeNull();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    await worker.close();
    db.close();
  }
});
