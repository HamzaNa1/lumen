import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
