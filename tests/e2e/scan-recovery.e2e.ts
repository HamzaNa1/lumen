import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "./support/server";

for (const attempts of [1, 3])
  test(`server restart recovers a crashed scanner with ${attempts} attempts`, async ({
    server,
    admin,
  }) => {
    const token = admin.accessToken;
    const library = await server.library(token, "movies", ["Film.mp4"]);
    await server.stop();
    const db = new DatabaseSync(server.databasePath);
    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    try {
      db.prepare(
        "INSERT INTO scan_runs(id,library_id,mode,status,created_at_ms,started_at_ms) VALUES(?,?,'incremental','running',1,1)",
      ).run(runId, library.id);
      db.prepare(
        "INSERT INTO scan_jobs(id,run_id,dedupe_key,operation,status,attempts,max_attempts,available_at_ms,started_at_ms,locked_at_ms,locked_by) VALUES(?,?,?,'discover','running',?,3,1,1,1,'dead-worker')",
      ).run(jobId, runId, `discover:${library.rootId}`, attempts);
    } finally {
      db.close();
    }
    await server.start();
    await expect
      .poll(async () => (await server.api<{ status: string }>(`/scans/${runId}`, { token })).status)
      .toBe(attempts === 1 ? "succeeded" : "failed");
    const jobs = await server.api<
      { attempts: number; lockedBy: string | null; finishedAtMs: number | null }[]
    >(`/scans/${runId}/jobs`, { token });
    expect(jobs.find((job) => job.attempts >= attempts)?.finishedAtMs).not.toBeNull();
    expect(await server.items(token, library.id)).toHaveLength(1);
    await server.scan(token, library.id);
  });

test("an unreachable root keeps its catalog; recovery and root deletion preserve unrelated media", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4"]);
  const before = await server.items(token, library.id);
  const offline = `${library.path}-offline`;
  await rename(library.path, offline);
  const run = await server.api<{ runId: string }>("/scans", {
    token,
    body: { libraryId: library.id, mode: "full" },
    status: 202,
  });
  await expect
    .poll(
      async () => (await server.api<{ status: string }>(`/scans/${run.runId}`, { token })).status,
      { timeout: 30000 },
    )
    .toMatch(/succeeded|failed/);
  expect(await server.items(token, library.id)).toEqual(before);
  const roots = await server.api<{ isAvailable: boolean }[]>(`/libraries/${library.id}/roots`, {
    token,
  });
  expect(roots[0]?.isAvailable).toBe(false);
  await rename(offline, library.path);
  await server.scan(token, library.id);
  expect(await server.items(token, library.id)).toEqual(before);
  const other = await server.library(token, "movies", ["Other.mp4"]);
  await server.api(`/roots/${library.rootId}`, { token, method: "DELETE" });
  expect(await server.items(token, library.id)).toEqual([]);
  expect(await server.items(token, other.id)).toHaveLength(1);
});

test("watcher notices filesystem changes and queued work survives a server restart", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["First.mp4"]);
  await server.stop();
  await server.start({ LUMEN_LIBRARY_WATCH_INTERVAL_MS: "1000" });
  await server.media(library.path, "Second.mp4");
  await expect
    .poll(async () => (await server.items(token, library.id)).map((item) => item.title).sort(), {
      timeout: 15000,
    })
    .toEqual(["First", "Second"]);
  await rm(join(library.path, "First.mp4"));
  await writeFile(join(library.path, "keep.txt"), "The root is still mounted");
  await expect
    .poll(async () => (await server.items(token, library.id)).map((item) => item.title), {
      timeout: 15000,
    })
    .toEqual(["Second"]);
});
