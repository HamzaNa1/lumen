import { openMovie, pause, playing, signIn } from "./support/browser";
import { expect, test } from "./support/server";

test("browser sign-in protects cookies, restores routes and propagates logout across tabs", async ({
  server,
  admin: _admin,
  page,
  context,
}) => {
  await signIn(page, server);
  const cookie = (await context.cookies()).find((cookie) => cookie.name === "lumen_session");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api" });
  expect(
    await page.evaluate(() =>
      JSON.stringify({ cookie: document.cookie, localStorage, sessionStorage }),
    ),
  ).not.toContain(cookie?.value ?? "missing");
  for (const path of ["search", "settings", "admin", "admin/users", "admin/jobs", "library"]) {
    await page.goto(`${server.origin}web/${path}`);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".page").first()).toBeVisible();
  }
  const other = await context.newPage();
  await other.goto(`${server.origin}web/settings`);
  await expect(other.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.goto(`${server.origin}web/settings`);
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /Sign out/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(other.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("real playback supports controls, fullscreen, buffering, diagnostics and teardown without exposing grants", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film (2019).mp4"]);
  await signIn(page, server);
  await openMovie(page, server, library.id);
  const video = page.locator("video");
  const exposure = await page.evaluate(() => ({
    location: location.href,
    storage: JSON.stringify({ localStorage, sessionStorage }),
    source: document.querySelector("video")?.src,
  }));
  expect(exposure.source).toContain("grant=");
  expect(exposure.location).not.toContain("grant");
  expect(exposure.storage).not.toContain("grant");
  await pause(page);
  await expect(page.getByText(/^Ends at \d{1,2}:\d{2}/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Next episode" })).toHaveCount(0);
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toBeVisible();
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  const volume = page.getByRole("slider", { name: "Volume" });
  await volume.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => video.evaluate((video: HTMLVideoElement) => video.volume)).toBe(0);
  await page.keyboard.press("End");
  await expect.poll(() => video.evaluate((video: HTMLVideoElement) => video.volume)).toBe(1);
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await page.getByRole("button", { name: "Playback info", exact: true }).click();
  await expect(page.getByText("Playback info", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Playback info" })).toContainText(
    "Video resolution",
  );
  await page.mouse.move(310, 310);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(video).toHaveCount(0);
});

test("each title remembers volume and episode navigation crosses seasons and skips combined overlaps", async ({
  server,
  admin,
  page,
}) => {
  const token = admin.accessToken;
  const movies = await server.library(token, "movies", ["Film.mp4"]);
  const shows = await server.library(token, "shows", [
    "Serial/Season 1/Serial S01E01 - Pilot.mp4",
    "Serial/Season 1/Serial S01E02-E03 - Together.mp4",
    "Serial/Season 1/Serial S01E03 - Overlap.mp4",
    "Serial/Season 2/Serial S02E01 - Return.mp4",
  ]);
  await signIn(page, server);
  const episode = async (season: string, title: string) => {
    await page.goto(`${server.origin}web/library/${shows.id}`);
    await page
      .getByRole("button", { name: "Play Serial", exact: true })
      .first()
      .click({ force: true });
    await page
      .getByRole("button", { name: `Play ${season}`, exact: true })
      .first()
      .click({ force: true });
    await page
      .getByRole("button", { name: `Play ${title}`, exact: true })
      .first()
      .click({ force: true });
    await playing(page);
    await pause(page);
  };
  const setVolume = async (value: number) => {
    await page.getByRole("slider", { name: "Volume" }).focus();
    await page.keyboard.press("End");
    for (let level = 100; level > value; level -= 10) await page.keyboard.press("PageDown");
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
      .toBeCloseTo(value / 100);
  };
  await episode("Season 1", "Pilot");
  await setVolume(30);
  await openMovie(page, server, movies.id);
  await pause(page);
  await setVolume(80);
  await episode("Season 2", "Return");
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
    .toBeCloseTo(0.3);
  await episode("Season 1", "Together");
  await page.getByRole("button", { name: "Next episode", exact: true }).click();
  await playing(page);
  await expect(page.getByRole("region", { name: "Media player" })).toContainText("Return");
  await page.reload();
  await openMovie(page, server, movies.id);
  await expect
    .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
    .toBeCloseTo(0.8);
});

test("revoked browser sessions return to sign-in and allow a fresh account session", async ({
  server,
  admin,
  page,
  context,
}) => {
  expect(admin.accessToken).toBeTruthy();
  await signIn(page, server);
  const cookie = (await context.cookies()).find((cookie) => cookie.name === "lumen_session");
  const logout = await server.request("/api/v1/auth/browser/logout", {
    method: "POST",
    headers: {
      cookie: `lumen_session=${cookie?.value}`,
      origin: new URL(server.origin).origin,
      "x-lumen-csrf": "1",
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(logout.status).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await signIn(page, server);
  expect(
    (await context.cookies()).find((cookie) => cookie.name === "lumen_session")?.value,
  ).not.toBe(cookie?.value);
});

test("older server capabilities keep playback and settings usable without unsupported track or watch requests", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const unsupported: string[] = [];
  page.on("request", (request) => {
    if (/track-preferences|track-choice|adjacent-episodes|watch-groups/.test(request.url()))
      unsupported.push(request.url());
  });
  await page.route("**/api/v1/server", async (route) => {
    const response = await route.fetch();
    const identity = await response.json();
    delete identity.capabilities;
    await route.fulfill({ response, json: identity });
  });
  await signIn(page, server);
  await page.goto(`${server.origin}web/settings`);
  await expect(page.locator(".page")).toBeVisible();
  await openMovie(page, server, library.id);
  await pause(page);
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Playback info", exact: true })).toBeVisible();
  expect(unsupported).toEqual([]);
});
