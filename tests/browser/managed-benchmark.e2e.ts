import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { signIn } from "./session";
import { buffer, capabilities, loaded, selectDelivery, startFilm } from "./playback";

const frameAt = (page: Page, position?: number) =>
  page.evaluate(async (target) => {
    const video = document.querySelector("video");
    if (video === null) throw new Error("Missing video");
    video.muted = true;
    const frame = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No decoded frame")), 10_000);
      const next = () =>
        video.requestVideoFrameCallback((_now, metadata) => {
          if (target === undefined || Math.abs(metadata.mediaTime - target) < 0.5) {
            clearTimeout(timer);
            resolve();
          } else next();
        });
      next();
    });
    if (target !== undefined) video.currentTime = target;
    await video.play();
    await frame;
  }, position);

const percentile = (values: readonly number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ] ?? 0;

for (const profile of ["local", "150ms-4Mbps"] as const) {
  test(`records original-quality direct/managed startup and seek baselines: ${profile}`, async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(
      browserName !== "chromium",
      "One decoder-enabled engine is used for repeatable timing; codec coverage runs on all engines",
    );
    test.setTimeout(120_000);
    await signIn(page);
    expect((await capabilities(page)).managed).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    if (profile !== "local") {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: 500_000,
        uploadThroughput: 1_000_000,
      });
    }
    const metricsBefore = await (await page.request.get("/metrics")).text();
    const samples: {
      delivery: string;
      cache: "direct" | "cold" | "warm";
      startupToObservedFrameMs: number;
      seekToFrameMs: number[];
      requests: number;
      responseBytes: number;
      bufferSnapshots: Awaited<ReturnType<typeof buffer>>[];
      sampledPeakManagedEncodedBytes: number | null;
    }[] = [];
    for (const delivery of ["direct", "managed"] as const) {
      await selectDelivery(page, delivery);
      for (let sample = 0; sample < 3; sample += 1) {
        let requests = 0;
        let responseBytes = 0;
        const segments = new Map<string, { start: number; end: number }>();
        const sizes = new Map<string, number>();
        const observed: Promise<void>[] = [];
        const response = (message: import("@playwright/test").Response) => {
          const path = new URL(message.url()).pathname;
          if (!/\/api\/v1\/(media|managed-media)\//u.test(path)) return;
          requests += 1;
          const size = Number(message.headers()["content-length"] ?? 0);
          responseBytes += size;
          const name = path.slice(path.lastIndexOf("/") + 1);
          sizes.set(name, size);
          if (name === "index.m3u8")
            observed.push(
              message.text().then((playlist) => {
                let start = 0;
                let duration = 0;
                for (const line of playlist.split("\n")) {
                  if (line.startsWith("#EXTINF:")) duration = Number(line.slice(8).split(",")[0]);
                  if (/^segment-\d+\.m4s$/u.test(line)) {
                    segments.set(line, { start, end: start + duration });
                    start += duration;
                  }
                }
              }),
            );
        };
        page.on("response", response);
        await page.goto("/web/library");
        const started = Date.now();
        await startFilm(page, `Benchmark ${profile}`);
        await loaded(page);
        await frameAt(page);
        const startupToObservedFrameMs = Date.now() - started;
        const bufferSnapshots = [await buffer(page)];
        const seekToFrameMs: number[] = [];
        for (const position of [15, 1, 18]) {
          const seekedAt = Date.now();
          await frameAt(page, position);
          seekToFrameMs.push(Date.now() - seekedAt);
          bufferSnapshots.push(await buffer(page));
        }
        await Promise.all(observed);
        const sampledPeakManagedEncodedBytes =
          delivery === "managed"
            ? Math.max(
                ...bufferSnapshots.map((snapshot) =>
                  [...segments].reduce(
                    (total, [name, segment]) =>
                      total +
                      (snapshot.ranges.some(
                        ([start, end]) => start < segment.end && end > segment.start,
                      )
                        ? (sizes.get(name) ?? 0)
                        : 0),
                    0,
                  ),
                ),
              )
            : null;
        await page.mouse.move(300, 300);
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
        page.off("response", response);
        samples.push({
          delivery,
          cache: delivery === "direct" ? "direct" : sample === 0 ? "cold" : "warm",
          startupToObservedFrameMs,
          seekToFrameMs,
          requests,
          responseBytes,
          bufferSnapshots,
          sampledPeakManagedEncodedBytes,
        });
      }
    }
    const summary = Object.fromEntries(
      ["direct", "managed"].map((delivery) => {
        const selected = samples.filter((sample) => sample.delivery === delivery);
        const startup = selected.map((sample) => sample.startupToObservedFrameMs);
        const seeks = selected.flatMap((sample) => sample.seekToFrameMs);
        return [
          delivery,
          {
            startupP50Ms: percentile(startup, 0.5),
            startupP95Ms: percentile(startup, 0.95),
            seekP50Ms: percentile(seeks, 0.5),
            seekP95Ms: percentile(seeks, 0.95),
          },
        ];
      }),
    );
    const artifact = testInfo.outputPath(`managed-streaming-baseline-${profile}.json`);
    await writeFile(
      artifact,
      JSON.stringify(
        {
          profile,
          corpus: "20-second H.264/AAC fixture",
          samples,
          summary,
          metricsBefore,
          metricsAfter: await (await page.request.get("/metrics")).text(),
          limitations:
            "Three samples; startup includes page navigation and the first observed decoded frame. Response bytes use Content-Length and can overestimate transfer after cancellation. Managed retained-byte estimates count complete segments overlapping sampled actual buffer ranges; they exclude in-flight transfers, decoder/MSE overhead, and peaks between observations. Native direct buffers do not expose encoded bytes. CPU/IO metrics cover the packaging FFmpeg process. This small fixture cannot establish production performance or justify promoting Auto.",
        },
        null,
        2,
      ),
    );
    await testInfo.attach(`managed-streaming-baseline-${profile}`, {
      contentType: "application/json",
      path: artifact,
    });
    await cdp.detach();
  });
}
