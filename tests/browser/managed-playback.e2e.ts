import { expect, test } from "@playwright/test";
import { signIn } from "./session";

import {
  buffer,
  capabilities,
  loaded,
  selectDelivery,
  startFilm as startLongFilm,
} from "./playback";

test("managed delivery decodes under CSP or exposes capability-dependent fallback", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const support = await capabilities(page);
  const violations: string[] = [];
  const requests: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/u.test(message.text())) violations.push(message.text());
  });
  page.on("request", (request) => {
    requests.push(new URL(request.url()).pathname);
  });
  await selectDelivery(page, "managed");
  await startLongFilm(page);
  if (!support.managed && !support.direct) {
    await expect(page.getByText(/can’t play this file’s format|could not be played/u)).toBeVisible({
      timeout: 25_000,
    });
  } else {
    await loaded(page);
    const start = page.getByRole("button", { name: "Play", exact: true });
    if (await start.isVisible()) await start.click();
    await page.evaluate(async () => {
      const video = document.querySelector("video");
      if (video !== null) {
        video.muted = true;
        await video.play();
      }
    });
    await expect
      .poll(() => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0))
      .toBeGreaterThan(0.2);
    const exposure = await page.evaluate(() => ({
      source: document.querySelector("video")?.src ?? "",
      storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
      href: location.href,
    }));
    expect(exposure.storage).not.toContain("grant");
    expect(exposure.href).not.toContain("grant");
    if (support.managed) {
      expect(exposure.source).toMatch(/^blob:/u);
      expect(
        requests.some((path) => path.includes("/managed-media/") && path.endsWith(".m4s")),
      ).toBe(true);
      expect(requests.some((path) => path.includes("hls.worker") && path.endsWith(".js"))).toBe(
        true,
      );
    } else {
      expect(exposure.source).toContain("grant=");
      expect(requests.some((path) => path.includes("/managed-media/"))).toBe(false);
    }
  }
  expect(violations).toEqual([]);
  await testInfo.attach("browser-codec-coverage", {
    body: JSON.stringify({
      browser: testInfo.project.name,
      ...support,
      actualManagedRequests: requests.filter((path) => path.includes("/managed-media/")),
    }),
    contentType: "application/json",
  });
});

test("paused managed loading is bounded and repeated distant seeks target the final position", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const support = await capabilities(page);
  test.skip(
    !support.managed,
    "This browser build reports no MSE decoder for the admitted profile; fallback is tested separately",
  );
  await selectDelivery(page, "managed");
  const segments: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/segment-\d+\.m4s$/u.test(path)) segments.push(path);
  });
  await startLongFilm(page);
  await loaded(page);
  await page.evaluate(() => document.querySelector("video")?.pause());
  await page.waitForTimeout(1500);
  const initial = await buffer(page);
  const count = segments.length;
  await page.waitForTimeout(1200);
  expect(segments.length).toBe(count);
  const ahead = initial.ranges.find(
    ([start, end]) => start <= initial.position && end > initial.position,
  );
  expect(ahead, JSON.stringify(initial)).toBeDefined();
  expect((ahead?.[1] ?? 0) - initial.position).toBeLessThanOrEqual(45.5);
  expect((ahead?.[1] ?? 0) - initial.position).toBeGreaterThanOrEqual(5);
  expect(new Set(segments).size).toBeLessThanOrEqual(5);
  for (const position of [90, 20, 65, 105]) {
    await page.evaluate((next) => {
      const video = document.querySelector("video");
      if (video !== null) video.currentTime = next;
    }, position);
    await page.waitForTimeout(150);
  }
  await expect
    .poll(
      async () => (await buffer(page)).ranges.some(([start, end]) => start <= 105 && end >= 110),
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(segments.at(-1)).toMatch(/segment-(10|11)\.m4s$/u);
  const final = await buffer(page);
  expect(final.position).toBeCloseTo(105, 0);
  const retained = final.ranges.reduce((sum, [start, end]) => sum + end - start, 0);
  expect(retained).toBeLessThanOrEqual(75);
  await testInfo.attach("managed-buffer-ranges", {
    body: JSON.stringify({ initial, final, requests: segments }),
    contentType: "application/json",
  });
});

test("a segment retry preserves the session and initial near-end resume skips the beginning", async ({
  page,
}, testInfo) => {
  await signIn(page);
  test.skip(
    !(await capabilities(page)).managed,
    "This browser build reports no MSE decoder for the admitted profile",
  );
  await selectDelivery(page, "managed");
  const sessions: string[] = [];
  const segments: string[] = [];
  let faults = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/playback/sessions" && request.method() === "POST")
      sessions.push(request.postData() ?? "");
    if (/segment-\d+\.m4s$/u.test(path)) segments.push(path);
  });
  const item = await page.evaluate(async () => {
    const libraries = (await (await fetch("/api/v1/libraries")).json()) as { id: string }[];
    const items = (await (await fetch(`/api/v1/items?libraryId=${libraries[0]?.id}`)).json()) as {
      items: { id: string; title: string }[];
    };
    return items.items.find((entry) => entry.title === "Long film")?.id;
  });
  expect(item).toBeDefined();
  await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/items/${id}/watch-state`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-lumen-csrf": "1" },
      body: JSON.stringify({ positionSeconds: 105, completed: false }),
    });
    if (!response.ok) throw new Error("Unable to set resume point");
  }, item);
  await page.route("**/managed-media/**/segment-*.m4s", async (route) => {
    if (faults === 0) {
      faults += 1;
      await route.fulfill({ status: 503, headers: { "retry-after": "1" }, body: "temporary" });
    } else await route.continue();
  });
  const startedAt = Date.now();
  await startLongFilm(page);
  await loaded(page);
  expect(faults).toBe(1);
  expect(sessions).toHaveLength(1);
  expect(segments.length).toBeGreaterThanOrEqual(2);
  expect(segments[0]).toMatch(/segment-10\.m4s$/u);
  expect(segments[1]).toBe(segments[0]);
  expect(segments.some((path) => path.endsWith("segment-0.m4s"))).toBe(false);
  await testInfo.attach("managed-local-recovery", {
    body: JSON.stringify({
      startupMs: Date.now() - startedAt,
      sessions: sessions.length,
      requests: segments,
    }),
    contentType: "application/json",
  });
});

test("leaving during preparation cancels its waiter and cannot resurrect playback", async ({
  page,
}) => {
  await signIn(page);
  test.skip(
    !(await capabilities(page)).managed,
    "This browser build reports no MSE decoder for the admitted profile",
  );
  await selectDelivery(page, "managed");
  let arrived: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route("**/playback/sessions/*/managed", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    arrived();
    await page.waitForTimeout(1500);
    await route.fulfill({ response }).catch(() => undefined);
  });
  await startLongFilm(page);
  await requested;
  await expect(page.getByText("Preparing managed playback…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.waitForTimeout(1800);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/player$/u);
});
