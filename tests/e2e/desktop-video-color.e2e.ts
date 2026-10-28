import { connectDesktop, expect, test } from "./support/desktop";

// Independent source values from the SDR chart, before YUV encoding or display processing.
const expected = [
  [0, 0, 0],
  [32, 32, 32],
  [64, 64, 64],
  [128, 128, 128],
  [192, 192, 192],
  [255, 255, 255],
  [160, 80, 64],
  [64, 144, 96],
  [64, 96, 160],
  [192, 144, 112],
];

test("Windows playback preserves SDR gray levels and muted colors through the compositor", async ({
  server,
  admin,
  desktop,
}, testInfo) => {
  test.skip(process.platform !== "win32", "Windows shared D3D11 compositor");
  await server.library(admin.accessToken, "movies", [], { "Colors.mp4": "sdr-colors.mp4" });
  const { page, app } = desktop;
  await connectDesktop(page, server);
  await page.getByRole("link", { name: "movies", exact: true }).click();
  await page.getByRole("button", { name: "Play Colors", exact: true }).first().click();
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: false });
  await page.evaluate(async () => {
    const state = await window.lumen.player.state();
    if (!state) throw new Error("Playback missing");
    await window.lumen.player.pause(state.sessionId, true);
  });
  const mainWindow = await app.browserWindow(page);
  const sample = async () => {
    const bounds = await page.locator(".watch-surface canvas").boundingBox();
    if (!bounds) throw new Error("Video canvas missing");
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return mainWindow.evaluate(
      async (window, { bounds, viewport }) => {
        const capture = await window.webContents.capturePage();
        const size = capture.getSize();
        const pixels = capture.toBitmap();
        const scaleX = size.width / viewport.width,
          scaleY = size.height / viewport.height;
        const videoWidth = Math.min(bounds.width, (bounds.height * 16) / 9);
        const left = bounds.x + (bounds.width - videoWidth) / 2;
        const y = Math.floor((bounds.y + bounds.height / 2) * scaleY);
        return Array.from({ length: 10 }, (_, index) => {
          const x = Math.floor((left + ((index + 0.5) * videoWidth) / 10) * scaleX);
          const offset = (y * size.width + x) * 4;
          return [pixels[offset + 2], pixels[offset + 1], pixels[offset]];
        });
      },
      { bounds, viewport },
    );
  };
  try {
    await expect
      .poll(
        async () => {
          const actual = await sample();
          return Math.max(
            ...expected.flatMap((color, index) =>
              color.map((value, channel) => Math.abs((actual[index]?.[channel] ?? -255) - value)),
            ),
          );
        },
        { message: "Captured SDR colors must match the source within four code values" },
      )
      .toBeLessThanOrEqual(4);
  } finally {
    await testInfo.attach("SDR color measurements", {
      body: JSON.stringify({ expected, actual: await sample() }, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("Windows SDR color chart", {
      body: Buffer.from(
        await mainWindow.evaluate(async (window) =>
          (await window.webContents.capturePage()).toPNG().toString("base64"),
        ),
        "base64",
      ),
      contentType: "image/png",
    });
  }
});
