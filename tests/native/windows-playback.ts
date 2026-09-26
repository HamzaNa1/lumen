// Run with Electron on Windows, outside Bun's mocked integration-test process.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BaseWindow, desktopCapturer, ipcMain, screen } from "electron";
import { load } from "koffi";
import type { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import type { MpvIpc } from "../../apps/desktop/src/main/player/MpvIpc";
import { MpvProcess } from "../../apps/desktop/src/main/player/MpvProcess";
import { MpvSurface } from "../../apps/desktop/src/main/player/MpvSurface";
import { PlaybackBridge } from "../../apps/desktop/src/main/player/PlaybackBridge";
import { PlayerController } from "../../apps/desktop/src/main/player/PlayerController";
import { PlayerOverlayWindow } from "../../apps/desktop/src/main/player/PlayerOverlayWindow";
import { createMainWindow } from "../../apps/desktop/src/main/windows";

const root = resolve("apps/desktop");
const evidence = join(root, "out/playback-evidence");
mkdirSync(evidence, { recursive: true });
const observations: unknown[] = [];
const clip = readFileSync("tests/fixtures/playback.mp4");
// Use the same bundled executable as the installed app, not a PATH shim.
process.chdir(root);
const startMpv = MpvProcess.start;
let processNumber = 0;
MpvProcess.start = (options) =>
  startMpv({
    ...options,
    videoOutputArguments: [
      ...(options.videoOutputArguments ?? []),
      `--log-file=${join(evidence, `mpv-${processNumber++}.log`)}`,
    ],
  });
const upstream = createServer((request, response) => {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), clip.length - 1) : clip.length - 1;
  response.writeHead(match ? 206 : 200, {
    "content-type": "video/mp4",
    "content-length": end - start + 1,
    "accept-ranges": "bytes",
    ...(match ? { "content-range": `bytes ${start}-${end}/${clip.length}` } : {}),
  });
  response.end(request.method === "HEAD" ? undefined : clip.subarray(start, end + 1));
});
const bridge = new PlaybackBridge();
let player: PlayerController | null = null;

async function run(): Promise<void> {
  assert.equal(process.platform, "win32");
  await app.whenReady();
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  await bridge.listen();
  const parent = createMainWindow();
  parent.setMinimumSize(640, 480);
  parent.setBounds({ x: 40, y: 40, width: 900, height: 600 });
  await parent.loadURL('data:text/html,<body style="background:black">');
  const overlay = new PlayerOverlayWindow(parent, join(root, "out/preload/index.cjs"));
  const surface = new MpvSurface(parent, overlay);
  player = new PlayerController({
    bridge,
    surface,
    onState: (state) => overlay.window.webContents.send("player:state", state),
  });
  const controller = player;
  controller.on("error", (error) => observations.push({ error: String(error) }));
  const display = {
    title: "Windows playback test",
    context: "",
    duration: 20,
    loading: false,
    error: null,
  };
  ipcMain.handle("player:state", () => controller.getState());
  ipcMain.handle("player:display-state", () => display);
  ipcMain.handle("player:fullscreen-state", () => false);
  await overlay.load(undefined, join(root, "out/renderer/index.html"));
  overlay.setVisible(true);
  parent.show();
  parent.focus();
  const [width, height] = parent.getContentSize();
  surface.setBounds({ x: 0, y: 0, width, height });
  const client = {
    serverOrigin: `http://127.0.0.1:${address.port}`,
    startPlayback: async () => ({
      sessionId: randomUUID(),
      itemId: "test-item",
      sourceId: "test-source",
      title: "Playback",
      streamUrl: "/clip.mp4",
      durationSeconds: 20,
      grantToken: "test",
      grantExpiresInSeconds: 60,
      streams: [
        {
          id: "audio-1",
          ordinal: 1,
          kind: "audio",
          codec: "aac",
          language: null,
          title: null,
          isDefault: true,
        },
      ],
    }),
    request: async () => undefined,
    heartbeat: async () => undefined,
    progress: async () => undefined,
  } as unknown as ServerClient;

  async function inspect(label: string): Promise<boolean> {
    await delay(750);
    const active = Reflect.get(controller, "active") as { ipc: MpvIpc };
    await active.ipc
      .command(["screenshot-to-file", join(evidence, `${label}-decoded.png`), "video"])
      .catch((error: unknown) => observations.push({ screenshotError: String(error) }));
    const properties: Record<string, unknown> = {};
    for (const name of [
      "time-pos",
      "pause",
      "vo-configured",
      "current-vo",
      "current-ao",
      "aid",
      "audio-params",
      "video-params",
      "audio-device-list",
    ]) {
      properties[name] = await active.ipc.command(["get_property", name]).catch(String);
    }
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    const source =
      sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
    assert(source, "No Windows desktop capture");
    writeFileSync(join(evidence, `${label}.png`), source.thumbnail.toPNG());
    const bounds = parent.getContentBounds();
    const image = source.thumbnail.crop({
      x: Math.round(bounds.x + bounds.width / 2 - 20),
      y: Math.round(bounds.y + bounds.height / 2 - 20),
      width: 40,
      height: 40,
    });
    const bitmap = image.toBitmap(); // Windows nativeImage pixels are BGRA.
    let redPixels = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap[i + 2] > 150 && bitmap[i + 1] < 80 && bitmap[i] < 80) redPixels++;
    }
    observations.push({
      label,
      properties,
      redPixels,
      windows: BaseWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
        bounds: window.getBounds(),
      })),
    });
    console.log(label, JSON.stringify(observations.at(-1)));
    return redPixels > 1400;
  }

  const visible: boolean[] = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    await controller.start({ client, connectionId: "test", itemId: "test-item" });
    visible.push(await inspect(`play-${iteration}`));
    if (iteration === 0 && !visible.at(-1)) {
      overlay.setVisible(false);
      await inspect("diagnostic-no-overlay");
      const host = Reflect.get(surface, "host") as BaseWindow;
      host.showInactive();
      host.moveTop();
      await inspect("diagnostic-host-top");
      const user32 = load("user32.dll");
      const getWindow = user32.func("uintptr_t __stdcall GetWindow(uintptr_t, unsigned int)");
      const getStyle = user32.func("long __stdcall GetWindowLongW(uintptr_t, int)");
      const isVisible = user32.func("int __stdcall IsWindowVisible(uintptr_t)");
      const showWindow = user32.func("int __stdcall ShowWindow(uintptr_t, int)");
      let child = getWindow(host.getNativeWindowHandle().readUInt32LE(), 5);
      while (child) {
        observations.push({
          child: String(child),
          style: getStyle(child, -16),
          visible: isVisible(child),
        });
        showWindow(child, 4);
        child = getWindow(child, 2);
      }
      await inspect("diagnostic-show-children");
      user32.unload();
      overlay.setVisible(true);
    }
    await controller.tick();
    const state = controller.getState();
    assert(state && state.positionSeconds > 0, "Playback clock did not advance");
    assert.equal(state.selectedAudioStreamId, "audio-1");
    controller.pause(state.sessionId, true);
    controller.seek(state.sessionId, 5);
    visible.push(await inspect(`seek-${iteration}`));
    controller.pause(state.sessionId, false);
    await controller.stop();
    assert.equal(controller.getState(), null);
  }
  assert(
    visible.every(Boolean),
    "Video is black: expected a red frame in every desktop screenshot",
  );
  console.log("Native Windows playback passed");
}

const timeout = setTimeout(() => {
  observations.push({ error: "Smoke test timed out" });
  writeFileSync(join(evidence, "results.json"), JSON.stringify(observations, null, 2));
  app.exit(1);
}, 90_000);
void run().then(
  () => finish(0),
  (error: unknown) => {
    console.error(error);
    observations.push({ error: String(error) });
    return finish(1);
  },
);
async function finish(code: number): Promise<void> {
  clearTimeout(timeout);
  writeFileSync(join(evidence, "results.json"), JSON.stringify(observations, null, 2));
  await player?.stop();
  upstream.closeAllConnections();
  upstream.close();
  await bridge.close();
  app.exit(code);
}
