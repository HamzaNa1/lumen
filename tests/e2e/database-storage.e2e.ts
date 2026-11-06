import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMigrations, openDatabase } from "./support/database";
import { expect, repository, test } from "./support/server";

test("database client commits a full music transaction, exposes it to another process and atomically claims persisted work", async ({
  playwright: _playwright,
}) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-storage-"));
  const command = (operation: string) =>
    JSON.parse(
      execFileSync(
        "bun",
        [
          join(repository, "tests/e2e/support/database/transaction.ts"),
          join(root, "catalog.sqlite"),
          operation,
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
  try {
    expect(command("create")).toEqual({ created: true });
    const read = command("read");
    expect(read.libraries).toHaveLength(1);
    expect(read.grants[0].capabilities).toContain("playback:control");
    expect(read.sessions).toHaveLength(1);
    expect(read.chapters[0]).toMatchObject({ title: "Opening", endMs: 30000 });
    expect(read.metadata[0].valueJson).toBe('{"trackGain":-7.2}');
    expect(read.state.positionMs).toBe(12000);
    expect(read.favorite).toBe(true);
    expect(read.progress[0].positionMs).toBe(17000);
    expect(read.search.map((item: { entityType: string }) => item.entityType).sort()).toEqual([
      "album",
      "track",
    ]);
    const claimed = command("claim");
    expect(claimed.job).toMatchObject({ status: "running", attempts: 1 });
    expect(claimed.event).toMatchObject({ status: "processing", attempts: 1 });
    expect(command("read").jobs[0].lockedBy).toBe(claimed.job.lockedBy);
    expect(command("revoke")).toEqual([]);
    expect(command("read").sessions).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrations validate foreign keys once per migration state and never record a failed or interrupted validation", async ({
  playwright: _playwright,
}) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-validation-"));
  const shipped = join(repository, "packages/database/drizzle");
  const migrations = join(root, "drizzle");
  const filename = join(root, "catalog.sqlite");
  const names = await listMigrations(shipped);
  const ship = async (count: number) => {
    for (const name of names.slice(0, count))
      await cp(join(shipped, name), join(migrations, name), { recursive: true });
  };
  const start = (interference?: string) => {
    const result = spawnSync(
      "bun",
      [
        "--preload",
        join(repository, "tests/e2e/support/process-coverage.ts"),
        join(repository, "tests/e2e/support/database/migrate-entry.ts"),
        filename,
        migrations,
        ...(interference === undefined ? [] : [interference]),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    const events: {
      type: string;
      applied?: number;
      violations?: number;
      durationMs?: number;
      blocked?: boolean;
    }[] = result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    return { status: result.status, signal: result.signal, events, stderr: result.stderr };
  };
  const types = (run: ReturnType<typeof start>) => run.events.map((event) => event.type);
  const opened = ["open_started", "open_completed", "migrations_started", "migrations_completed"];
  const validated = [...opened, "foreign_key_check_started", "foreign_key_check_completed"];
  const skipped = [...opened, "foreign_key_check_skipped"];
  const rejected = [...opened, "foreign_key_check_started", "foreign_key_check_failed"];
  try {
    await mkdir(migrations);
    await ship(names.length - 2);

    // Validation holds the write lock, so a concurrent writer waits instead of committing
    // mid-check and leaving the record unwritable.
    const first = start("write:foreign_key_check_started");
    expect(first.status, first.stderr).toBe(0);
    expect(first.events.find(({ type }) => type === "concurrent_write")).toEqual({
      type: "concurrent_write",
      blocked: true,
    });
    first.events = first.events.filter(({ type }) => type !== "concurrent_write");
    expect(types(first)).toEqual(validated);
    expect(first.events[3]).toMatchObject({ applied: names.length - 2 });
    for (const event of first.events.filter(({ type }) => type.endsWith("_completed")))
      expect(event.durationMs).toBeGreaterThanOrEqual(0);

    const unchanged = start();
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(types(unchanged)).toEqual(skipped);
    expect(unchanged.events[3]).toMatchObject({ applied: 0 });

    // The new migration commits, then the process dies while validation is running.
    await ship(names.length - 1);
    const interrupted = start("kill:foreign_key_check_started");
    expect(interrupted.signal).toBe("SIGKILL");
    expect(types(interrupted)).toEqual([...opened, "foreign_key_check_started"]);
    expect(interrupted.events[3]).toMatchObject({ applied: 1 });
    const resumed = start();
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(types(resumed)).toEqual(validated);
    expect(resumed.events[3]).toMatchObject({ applied: 0 });
    expect(types(start())).toEqual(skipped);

    const database = openDatabase(filename);
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec(
        "INSERT INTO devices(id,user_id,name,platform,last_seen_at_ms,created_at_ms) VALUES('orphan','absent','Orphan','web',1,1)",
      );
    } finally {
      database.close();
    }
    // Enforcement keeps an ordinary restart from introducing violations, so only a
    // migration state that has not yet passed validation is checked again.
    expect(types(start())).toEqual(skipped);
    await ship(names.length);
    const failed = start();
    expect(failed.status).toBe(1);
    expect(types(failed)).toEqual(rejected);
    expect(failed.events[3]).toMatchObject({ applied: 1 });
    expect(failed.events[5]).toMatchObject({ violations: 1 });
    const retried = start();
    expect(retried.status).toBe(1);
    expect(types(retried)).toEqual(rejected);
    expect(retried.events[3]).toMatchObject({ applied: 0 });

    const repair = openDatabase(filename);
    try {
      repair.exec("DELETE FROM devices WHERE id = 'orphan'");
      expect(repair.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({
        count: names.length,
      });
    } finally {
      repair.close();
    }
    expect(types(start())).toEqual(validated);
    expect(types(start())).toEqual(skipped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
