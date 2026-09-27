// Run with Bun on macOS: bun tests/native/watch-group-playback.ts
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { MpvProcess } from "../../apps/desktop/src/main/player/MpvProcess";
import { MpvIpc } from "../../apps/desktop/src/main/player/MpvIpc";
import { runUntilMpvEvent } from "../../apps/desktop/src/main/player/MpvWait";

const player = MpvProcess.start({
  cwd: process.cwd(),
  resourcesPath: process.cwd(),
  videoOutputArguments: ["--vo=null", "--ao=null", "--force-window=no", "--keep-open=yes"],
});
const ipc = new MpvIpc();
try {
  await ipc.connect(player);
  await ipc.command(["set_property", "pause", "yes"]);
  await runUntilMpvEvent(ipc, "file-loaded", () =>
    ipc.command(["loadfile", resolve("tests/fixtures/playback.mp4"), "replace"]),
  );
  assert.equal(await ipc.command(["get_property", "pause"]), true);
  await runUntilMpvEvent(ipc, "playback-restart", () =>
    ipc.command(["seek", 1.25, "absolute+exact"]),
  );
  const position = await ipc.command(["get_property", "time-pos"]);
  assert.equal(typeof position, "number");
  assert(Math.abs((position as number) - 1.25) < 0.08);
  for (const speed of [1.05, 0.95, 1]) {
    await ipc.command(["set_property", "speed", speed]);
    assert.equal(await ipc.command(["get_property", "speed"]), speed);
  }
  assert.equal(await ipc.command(["get_property", "pause"]), true);
  assert.equal(typeof (await ipc.command(["get_property", "paused-for-cache"])), "boolean");
  assert.equal(await ipc.command(["get_property", "seeking"]), false);
  await runUntilMpvEvent(ipc, "file-loaded", () =>
    ipc.command(["loadfile", resolve("tests/fixtures/playback-ac3.mkv"), "replace"]),
  );
  assert.equal(await ipc.command(["get_property", "pause"]), true);
  assert.equal(await ipc.command(["get_property", "speed"]), 1);
  await assert.rejects(ipc.command(["set_property", "nonexistent-lumen-property", "yes"]));
  console.log(
    `PASS native ${process.platform}/${process.arch}: paused load, fractional exact seek completion, ±5% speed, pause preservation, source replacement, cache/seeking observation, rate reset, command errors`,
  );
} finally {
  ipc.close();
  await player.stop();
}
