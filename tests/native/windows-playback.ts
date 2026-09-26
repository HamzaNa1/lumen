// Run with Electron on Windows, outside Bun's mocked integration-test process.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  app,
  BaseWindow,
  type BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
} from "electron";
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
const scale = process.env.LUMEN_SMOKE_SCALE ?? "1";
app.commandLine.appendSwitch("force-device-scale-factor", scale);
const evidence = join(root, `out/playback-evidence/scale-${scale}`);
mkdirSync(evidence, { recursive: true });
const observations: unknown[] = [];
const asynchronousErrors: string[] = [];
// Fail instead of displaying Electron's modal exception dialog, which would
// otherwise hang CI. These handlers are test-only; production fixes the cause.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error) => {
    asynchronousErrors.push(String(error));
    observations.push({ error: String(error), event });
  });
}
app.on("window-all-closed", () => undefined);
const fixtures = [
  { name: "aac", data: readFileSync("tests/fixtures/playback.mp4") },
  { name: "dts", data: readFileSync("tests/fixtures/playback-dts.mkv") },
  { name: "ac3", data: readFileSync("tests/fixtures/playback-ac3.mkv") },
  { name: "eac3", data: readFileSync("tests/fixtures/playback-eac3.mkv") },
] as const;
let fixture: (typeof fixtures)[number] = fixtures[0];
// Use the same bundled executable as the installed app, not a PATH shim.
process.chdir(root);
const startMpv = MpvProcess.start;
const spawnedMpv: MpvProcess[] = [];
let processNumber = 0;
MpvProcess.start = (options) => {
  const index = processNumber++;
  const playerProcess = startMpv({
    ...options,
    videoOutputArguments: [
      ...(options.videoOutputArguments ?? []),
      `--log-file=${join(evidence, `mpv-${index}.log`)}`,
      // Hosted runners have no speakers. Verify decoded samples through PCM;
      // real WASAPI/speaker output still needs testing on a Windows PC.
      "--ao=pcm",
      "--audio-format=float",
      "--ao-pcm-waveheader=no",
      `--ao-pcm-file=${join(evidence, `audio-${index}.pcm`)}`,
    ],
  });
  spawnedMpv.push(playerProcess);
  return playerProcess;
};
const upstream = createServer((request, response) => {
  const clip = fixture.data;
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), clip.length - 1) : clip.length - 1;
  response.writeHead(match ? 206 : 200, {
    "content-type": fixture.name === "aac" ? "video/mp4" : "video/x-matroska",
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
  const user32 = load("user32.dll");
  const getSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int)");
  const isWindow = user32.func("int __stdcall IsWindow(uintptr_t)");
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  await bridge.listen();
  const parent = createMainWindow();
  const area = screen.getPrimaryDisplay().workArea;
  parent.setMinimumSize(400, 300);
  parent.setBounds({
    x: area.x + 20,
    y: area.y + 20,
    width: Math.min(900, area.width - 40),
    height: Math.min(600, area.height - 40),
  });
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
  ipcMain.handle("player:audio-output", (_event, input) =>
    controller.setAudioOutput(input.sessionId, input.output),
  );
  ipcMain.handle("player:copy-audio-diagnostics", async (_event, sessionId) => {
    await clipboard.writeText(await controller.audioDiagnostics(sessionId));
  });
  await overlay.load(undefined, join(root, "out/renderer/index.html"));
  overlay.setVisible(true);
  parent.show();
  parent.focus();
  const syncSurface = (): void => {
    const [width, height] = parent.getContentSize();
    surface.setBounds({ x: 0, y: 0, width, height });
  };
  syncSurface();
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
          codec: fixture.name,
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

  async function inspect(label: string, sampleX = 0.5): Promise<boolean> {
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
      "audio-out-params",
      "track-list",
      "video-params",
      "audio-device-list",
    ]) {
      properties[name] = await active.ipc.command(["get_property", name]).catch(String);
    }
    const display = screen.getPrimaryDisplay();
    const screenPixels = { width: getSystemMetrics(0), height: getSystemMetrics(1) };
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: screenPixels,
    });
    const source =
      sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
    assert(source, "No Windows desktop capture");
    const png = source.thumbnail.toPNG();
    writeFileSync(join(evidence, `${label}.png`), png);
    // Normalize the representation to 1x: nativeImage crop coordinates and
    // thumbnail bitmap pixels otherwise disagree under forced fractional DPI.
    const thumbnail = nativeImage.createFromBuffer(png, { scaleFactor: 1 });
    const bounds = screen.dipToScreenRect(parent, parent.getContentBounds());
    // Capturer thumbnails can be smaller than requested at fractional DPI.
    // Map screen coordinates to the actual image before sampling its center.
    const imageSize = thumbnail.getSize();
    const scaleX = imageSize.width / screenPixels.width;
    const scaleY = imageSize.height / screenPixels.height;
    const image = thumbnail.crop({
      x: Math.round((bounds.x + bounds.width * sampleX) * scaleX - 20),
      y: Math.round((bounds.y + bounds.height / 2) * scaleY - 20),
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
      capture: { imageSize, screenPixels, bounds, scaleX, scaleY, sampleX },
      windows: BaseWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
        bounds: window.getBounds(),
      })),
    });
    console.log(label, JSON.stringify(observations.at(-1)));
    assert.equal(properties["current-ao"], "pcm", "The audio output failed to initialize");
    return redPixels > 1400;
  }

  const visible: boolean[] = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    await controller.start({ client, connectionId: "test", itemId: "test-item" });
    visible.push(await inspect(`play-${iteration}`));
    await controller.tick();
    const state = controller.getState();
    assert(state && state.positionSeconds > 0, "Playback clock did not advance");
    assert.equal(state.selectedAudioStreamId, "audio-1");
    if (iteration === 1) {
      const bounds = parent.getBounds();
      parent.setSize(bounds.width - 50, bounds.height - 30);
      syncSurface();
      visible.push(await inspect("resized"));
      parent.minimize();
      await delay(250);
      parent.restore();
      parent.focus();
      visible.push(await inspect("restored"));
      parent.setFullScreen(true);
      await delay(250);
      syncSurface();
      visible.push(await inspect("fullscreen"));
      parent.setFullScreen(false);
      await delay(250);
      syncSurface();
      visible.push(await inspect("windowed"));
    }
    controller.pause(state.sessionId, true);
    controller.seek(state.sessionId, 5);
    visible.push(await inspect(`seek-${iteration}`));
    const { ipc } = Reflect.get(controller, "active") as { ipc: MpvIpc };
    assert.equal(await ipc.command(["get_property", "pause"]), true);
    assert(Math.abs(Number(await ipc.command(["get_property", "time-pos"])) - 5) < 0.1);
    controller.volume(state.sessionId, 35, true);
    assert.equal(await ipc.command(["get_property", "mute"]), true);
    assert.equal(await ipc.command(["get_property", "volume"]), 35);
    controller.volume(state.sessionId, 100, false);
    controller.pause(state.sessionId, false);
    visible.push(await inspect(`resume-${iteration}`));
    await controller.stop();
    assert.equal(controller.getState(), null);
    const audio = readFileSync(join(evidence, `audio-${iteration}.pcm`));
    assert(
      audio.length > 4_800 && audio.some((value) => value !== 0),
      "Decoded audio is missing or silent",
    );
  }
  for (const audioFixture of fixtures.slice(1)) {
    fixture = audioFixture;
    const index = processNumber;
    await controller.start({ client, connectionId: "test", itemId: "test-item" });
    visible.push(await inspect(`codec-${fixture.name}`));
    const state = controller.getState();
    assert(state);
    assert.equal(state.selectedAudioStreamId, "audio-1");
    assert.equal(state.audioOutput, "stereo");
    const diagnostics = JSON.parse(await controller.audioDiagnostics(state.sessionId));
    observations.push({ label: `diagnostics-${fixture.name}`, diagnostics });
    assert.equal(diagnostics.properties["audio-out-params"]["channel-count"], 2);
    assert.equal(diagnostics.properties["audio-out-params"].format, "float");
    assert.equal(diagnostics.properties.aid, diagnostics.expectedAudioTrack);
    await controller.stop();
    const audio = readFileSync(join(evidence, `audio-${index}.pcm`));
    assert(audio.length > 4_800 && audio.some((value) => value !== 0), `${fixture.name} is silent`);
    // DTS/AC-3 contain sound ONLY in the center channel. Verify that dialogue
    // reaches both stereo speakers, not just that some surround sample exists.
    const peaks = [0, 0];
    for (let offset = 0; offset + 8 <= audio.length; offset += 8) {
      peaks[0] = Math.max(peaks[0] ?? 0, Math.abs(audio.readFloatLE(offset)));
      peaks[1] = Math.max(peaks[1] ?? 0, Math.abs(audio.readFloatLE(offset + 4)));
    }
    observations.push({ label: `stereo-peaks-${fixture.name}`, peaks });
    assert(
      peaks.every((peak) => Number.isFinite(peak) && peak > 0.05),
      `${fixture.name}: center dialogue was lost`,
    );
  }
  // Changing the output mode must reconfigure the current file, including
  // while paused, without resetting playback or the chosen audio track.
  fixture = fixtures[1];
  await controller.start({ client, connectionId: "test", itemId: "test-item", startAtSeconds: 5 });
  const state = controller.getState();
  assert(state);
  controller.pause(state.sessionId, true);
  for (const output of ["auto-safe", "stereo"]) {
    const result = await overlay.window.webContents.executeJavaScript(
      `window.lumen.player.audioOutput(${JSON.stringify(state.sessionId)}, ${JSON.stringify(output)})`,
    );
    assert.equal(result.audioOutput, output);
  }
  const diagnostics = JSON.parse(await controller.audioDiagnostics(state.sessionId));
  assert.equal(diagnostics.properties["audio-channels"], "stereo");
  assert.equal(diagnostics.properties.pause, true);
  assert.equal(controller.getState()?.selectedAudioStreamId, "audio-1");
  controller.pause(state.sessionId, false);
  visible.push(await inspect("audio-output-changed"));
  await overlay.window.webContents.executeJavaScript(
    `document.querySelector('[aria-label="Playback settings"]').click()`,
  );
  await delay(100);
  await overlay.window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Copy audio diagnostics').click()`,
  );
  let copyStatus = "";
  for (let attempt = 0; attempt < 40 && copyStatus !== "Audio diagnostics copied."; attempt++) {
    await delay(50);
    copyStatus = await overlay.window.webContents.executeJavaScript(
      `document.querySelector('#media-player-settings-panel [role="status"]')?.textContent ?? ''`,
    );
  }
  assert.equal(copyStatus, "Audio diagnostics copied.");
  const copiedText = await clipboard.readText();
  const copied = JSON.parse(copiedText);
  assert.equal(copied.audioOutput, "stereo");
  assert.equal(copied.properties["audio-out-params"]["channel-count"], 2);
  assert.equal(copied.expectedAudioTrack, copied.properties.aid);
  assert(!copiedText.includes("127.0.0.1"), "Diagnostics leaked the stream URL");
  // The settings panel covers the center at 150% scaling. Sample the visible
  // video to its left while retaining a full desktop screenshot for UI review.
  visible.push(await inspect("audio-settings", 0.25));
  await controller.stop();
  assert(
    visible.every(Boolean),
    "Video is black: expected a red frame in every desktop screenshot",
  );
  async function closePlayerWindow(
    label: string,
    window: BrowserWindow,
    controls: PlayerOverlayWindow,
    video: MpvSurface,
    closingPlayer: PlayerController,
  ): Promise<void> {
    const host = Reflect.get(video, "host") as { getNativeWindowHandle(): Buffer };
    const handle = host.getNativeWindowHandle().readBigUInt64LE();
    assert.equal(isWindow(handle), 1);
    let stopped = Promise.resolve();
    const closed = new Promise<void>((resolve) =>
      window.once("closed", () => {
        stopped = closingPlayer.stop();
        resolve();
      }),
    );
    // Close in the same event-loop turn as blur: the original zero-delay
    // callback called isFocused() after its Electron window was destroyed.
    window.emit("blur");
    controls.window.emit("blur");
    window.close();
    await closed;
    await stopped;
    await delay(100); // Let queued focus work and native close events run.
    assert(window.isDestroyed());
    assert(controls.window.isDestroyed());
    assert.equal(isWindow(handle), 0, "The native video host survived its owner");
    assert.equal(closingPlayer.getState(), null);
    video.show();
    video.setBounds(null);
    controls.setVisible(false);
    controls.moveAboveVideo();
    video.dispose(); // Repeated cleanup and late IPC callbacks must be harmless.
    assert.deepEqual(asynchronousErrors, [], "Closing the player raised an asynchronous exception");
    observations.push({ label, closed: true, videoHostDestroyed: true, asynchronousErrors: [] });
  }

  overlay.setVisible(false); // Back: playback and its overlay have already stopped.
  await closePlayerWindow("close-after-stopping", parent, overlay, surface, controller);
  for (const paused of [false, true]) {
    const closingWindow = createMainWindow();
    await closingWindow.loadURL('data:text/html,<body style="background:black">');
    const closingOverlay = new PlayerOverlayWindow(
      closingWindow,
      join(root, "out/preload/index.cjs"),
    );
    const closingSurface = new MpvSurface(closingWindow, closingOverlay);
    const closingPlayer = new PlayerController({
      bridge,
      surface: closingSurface,
      onState: () => undefined,
    });
    player = closingPlayer;
    closingWindow.show();
    const [width, height] = closingWindow.getContentSize();
    closingSurface.setBounds({ x: 0, y: 0, width, height });
    closingOverlay.setVisible(true);
    await closingPlayer.start({ client, connectionId: "test", itemId: "test-item" });
    const closingState = closingPlayer.getState();
    assert(closingState);
    if (paused) closingPlayer.pause(closingState.sessionId, true);
    await delay(100);
    await closePlayerWindow(
      paused ? "close-while-paused" : "close-while-playing",
      closingWindow,
      closingOverlay,
      closingSurface,
      closingPlayer,
    );
  }
  for (const mpv of spawnedMpv) {
    const child = mpv.process;
    assert(
      child !== null && (child.exitCode !== null || child.signalCode !== null),
      "MPV survived window shutdown",
    );
  }
  assert.equal(BaseWindow.getAllWindows().length, 0, "A player window was left open");
  user32.unload();
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
  if (code === 0 && asynchronousErrors.length === 0) app.quit();
  else app.exit(1);
}
