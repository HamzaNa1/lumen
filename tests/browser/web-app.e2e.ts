import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { waitUntilPlaying } from "./playback";

const PASSWORD = "correct horse battery staple";

const signIn = async (page: Page): Promise<void> => {
  await page.goto("/web/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
};

const sessionCookie = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) => cookie.name === "lumen_session");

test("signs in with a cookie scripts cannot read, and a reload restores the session", async ({
  page,
  context,
}) => {
  await page.goto("/web");
  await expect(page).toHaveURL(/\/web\/$/u);
  // The server address is fixed to where the app was loaded from.
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Server address")).toHaveCount(0);
  await signIn(page);

  const cookie = await sessionCookie(context);
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api" });
  const visible = await page.evaluate(() => ({
    cookie: document.cookie,
    storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
  }));
  expect(visible.cookie).not.toContain("lumen_session");
  expect(visible.storage).not.toContain(cookie?.value ?? "missing");

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByText("Movies").first()).toBeVisible();
});

test("the page names its own icon, so the browser never asks the API for one", async ({ page }) => {
  const refused: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 401 && !new URL(response.url()).pathname.startsWith("/api/"))
      refused.push(response.url());
  });
  await page.goto("/web/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href).toMatch(/^\/web\/assets\/.+\.svg$/u);
  const icon = await page.request.get(href ?? "");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toBe("image/svg+xml");
  expect(refused).toEqual([]);
});

test("every route survives direct navigation and refresh", async ({ page }) => {
  await signIn(page);
  const libraryPath = await page
    .getByRole("link", { name: "Movies", exact: true })
    .getAttribute("href");
  for (const path of [
    "/web/search",
    "/web/settings",
    "/web/admin",
    "/web/admin/users",
    "/web/admin/jobs",
    "/web/library",
  ]) {
    await page.goto(path);
    // /library resolves to the viewer's first library, whose ID belongs to this fixture server.
    await expect(page).toHaveURL(
      (url) => url.pathname === (path === "/web/library" ? libraryPath : path),
    );
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".page").first()).toBeVisible();
  }
  await page.goto("/web/settings");
  await expect(page.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
});

test("an administrator renames the server from settings", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/web/settings");
  const server = page.getByRole("region", { name: "Server" }).locator(".settings-row").first();
  await expect(server).toContainText("Lumen Server");
  const rename = async (name: string): Promise<void> => {
    await server.getByRole("button", { name: "Rename…" }).click();
    await page.getByLabel("Server name").fill(name);
    await testInfo.attach("rename server", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(server).toContainText(name);
  };
  await rename("Living room");
  // The server keeps the name, so a fresh page load reads it back.
  await page.reload();
  await expect(server).toContainText("Living room");
  await rename("Lumen Server");
});

test("signing out in one tab signs out the others", async ({ page, context }) => {
  await signIn(page);
  const other = await context.newPage();
  await other.goto("/web/settings");
  await expect(other.getByRole("navigation", { name: "Primary" })).toBeVisible();

  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /Sign out/u }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(other.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(await sessionCookie(context)).toBeUndefined();
});

test("a session revoked on the server returns the app to sign-in", async ({ page, context }) => {
  await signIn(page);
  const cookie = await sessionCookie(context);
  const sessionId = cookie?.value.split(".")[0];
  const revoked = await page.evaluate(
    async (id) =>
      (
        await fetch(`/api/v1/auth/sessions/${id}`, {
          method: "DELETE",
          headers: { "x-lumen-csrf": "1" },
        })
      ).status,
    sessionId,
  );
  expect(revoked).toBe(200);
  // The next request the app makes is refused. That may be one already under way, so the
  // sidebar can be gone at any moment; go straight to a page rather than clicking through it.
  await page.goto("/web/admin/users");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("an old unauthorized request cannot erase a newer sign-in's cookie", async ({
  page,
  context,
}) => {
  // Keep the actual browser cookie jar, but leave the app runtime out of the race.
  await page.goto("/health/live");
  const login = () =>
    page.evaluate(
      async (password) =>
        (
          await fetch("/api/v1/auth/browser/login", {
            method: "POST",
            headers: { "content-type": "application/json", "x-lumen-csrf": "1" },
            body: JSON.stringify({
              username: "admin",
              password,
              deviceId: crypto.randomUUID(),
              deviceName: "Cookie race",
            }),
          })
        ).status,
      PASSWORD,
    );
  expect(await login()).toBe(200);
  const oldCookie = await sessionCookie(context);
  const oldSessionId = oldCookie?.value.split(".")[0];
  expect(
    await page.evaluate(
      async (sessionId) =>
        (
          await fetch(`/api/v1/auth/sessions/${sessionId}`, {
            method: "DELETE",
            headers: { "x-lumen-csrf": "1" },
          })
        ).status,
      oldSessionId,
    ),
  ).toBe(200);
  let arrived!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(401);
    arrived();
    await gate;
    // Deliver the real server's old response only after the new cookie is installed.
    await route.fulfill({ response });
  });
  const oldRequest = page.evaluate(async () => (await fetch("/api/v1/auth/me")).status);
  try {
    await requested;
    expect(await login()).toBe(200);
    const newCookie = await sessionCookie(context);
    expect(newCookie?.value).not.toBe(oldCookie?.value);
    release();
    expect(await oldRequest).toBe(401);
    expect((await sessionCookie(context))?.value).toBe(newCookie?.value);
    expect(
      await page.evaluate(async () => (await fetch("/api/v1/auth/browser/session")).status),
    ).toBe(200);
  } finally {
    release();
    await oldRequest;
  }
});

test("a file the browser cannot play says so instead of loading forever", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/library");
  await page.getByRole("button", { name: "Play Clip" }).first().click({ force: true });
  await expect(page.getByText("Playback failed")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/can’t play this file’s format|could not be played/u)).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

/** Starts a fixture title from a page that lists it, and waits until it is really playing. */
const play = async (page: Page, title: string): Promise<void> => {
  await page
    .getByRole("button", { name: `Play ${title}` })
    .first()
    .click({ force: true });
  await waitUntilPlaying(page);
};
const playFilm = (page: Page): Promise<void> => play(page, "Film");

test("supported media plays under the shared controls", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/web/library");
  // Linux WebKit reports a synthetic status-zero response before its media backend's HTTP request.
  const stream = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/api/v1/media/") && response.status() !== 0,
  );
  await playFilm(page);
  const response = await stream;
  expect([200, 206]).toContain(response.status());
  expect(response.headers()["content-type"]).toBe(
    testInfo.project.name === "chromium" ? "video/mp4" : "video/webm",
  );
  // A film has no show to place it in, so only the year it came out sits under its title.
  await expect(
    page.getByRole("region", { name: "Media player" }).getByText("(2019)"),
  ).toBeVisible();
  await testInfo.attach("player on a film", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  // The grant that authorises the stream stays in the element, out of the address bar and storage.
  const exposure = await page.evaluate(() => ({
    href: location.href,
    storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
    source: document.querySelector("video")?.src ?? "",
  }));
  expect(exposure.source).toContain("grant=");
  expect(exposure.href).not.toContain("grant");
  expect(exposure.storage).not.toContain("grant");

  const isFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  await page.keyboard.press("f");
  await expect.poll(isFullscreen).toBe(true);
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toBeVisible();
  await page.keyboard.press("f");
  await expect.poll(isFullscreen).toBe(false);
  await expect(page.getByRole("button", { name: "Enter fullscreen", exact: true })).toBeVisible();

  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Pause playback" }).last().click();
  await expect.poll(() => page.evaluate(() => document.querySelector("video")?.paused)).toBe(true);
  await expect(page.getByText(/^Ends at \d{1,2}:\d{2}/u)).toBeVisible();
  // A film has nothing after it, but can still be taken back to its start.
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next episode" })).toHaveCount(0);
  await testInfo.attach("player ends at", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.mouse.move(320, 320);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector("video"))).toBeNull();
});

test("each show and film keeps its own volume, across all of a show's episodes", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const volumeSlider = page.getByRole("slider", { name: "Volume" });
  const elementVolume = () => page.evaluate(() => document.querySelector("video")?.volume);
  const playEpisode = async (season: string, episode: string): Promise<void> => {
    await page.goto("/web/library");
    await page.getByRole("button", { name: "Play Serial" }).first().click({ force: true });
    await page
      .getByRole("button", { name: `Play ${season}` })
      .first()
      .click({ force: true });
    await play(page, episode);
  };
  const playFilmFromLibrary = async (): Promise<void> => {
    await page.goto("/web/library");
    await playFilm(page);
  };
  /** Sets the volume from the keyboard: all the way up, then down in steps of ten. */
  const setVolume = async (volume: number): Promise<void> => {
    await page.mouse.move(300, 300);
    await volumeSlider.focus();
    await page.keyboard.press("End");
    for (let level = 100; level > volume; level -= 10) await page.keyboard.press("PageDown");
    await expect(volumeSlider).toHaveAttribute("aria-valuenow", String(volume));
    await expect.poll(elementVolume).toBeCloseTo(volume / 100);
  };
  const expectVolume = async (volume: number, shot: string): Promise<void> => {
    await expect.poll(elementVolume).toBeCloseTo(volume / 100);
    await page.mouse.move(310, 310);
    await expect(volumeSlider).toHaveAttribute("aria-valuenow", String(volume));
    await testInfo.attach(shot, { body: await page.screenshot(), contentType: "image/png" });
  };

  await playEpisode("Season 1", "Pilot");
  await expectVolume(100, "S01E01 starts at full volume");
  await setVolume(30);

  // A film never adjusted starts where the volume was last left.
  await playFilmFromLibrary();
  await expectVolume(30, "the film starts where the volume was last left");
  await setVolume(80);

  // Any episode of the show, in any season, plays as loud as the show was left.
  await playEpisode("Season 2", "Return");
  await expectVolume(30, "S02E01 plays at the show's volume");
  await playFilmFromLibrary();
  await expectVolume(80, "the film plays at its own volume");

  // Both outlast a reload.
  await page.reload();
  await playEpisode("Season 1", "Second");
  await expectVolume(30, "S01E02 after a reload plays at the show's volume");
});

test("the player moves between a show's episodes", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/web/library");
  // Playing a show or a season opens it, since only its episodes can play.
  await page.getByRole("button", { name: "Play Serial" }).first().click({ force: true });
  await page.getByRole("button", { name: "Play Season 1" }).first().click({ force: true });
  await play(page, "Second");
  const player = page.getByRole("region", { name: "Media player" });
  const previous = page.getByRole("button", { name: "Previous", exact: true });
  const next = page.getByRole("button", { name: "Next episode" });
  const currentTime = () => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  const expectPlaying = async (title: string, context: string): Promise<void> => {
    await expect(player.getByRole("heading", { name: title })).toBeVisible();
    await expect(player.getByText(context)).toBeVisible();
    await expect.poll(currentTime).toBeGreaterThan(0.2);
  };
  /** The controls hide while the pointer rests, so each press starts by moving it. */
  let pointer = 300;
  const press = async (button: typeof previous): Promise<void> => {
    await page.mouse.move(pointer, pointer);
    pointer += 5;
    await button.click();
  };
  await expectPlaying("Second", "Serial (2021) · S01E02");
  await page.mouse.move(pointer, pointer);
  await testInfo.attach("player with a previous and a next episode", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Past the first ten seconds, Previous goes back to the start of the same episode.
  await page.keyboard.press("ArrowRight");
  await expect.poll(currentTime).toBeGreaterThanOrEqual(10);
  await expect(page.locator(".media-player-time").first()).toHaveText(/^0:1\d$/u);
  await press(previous);
  await expect.poll(currentTime).toBeLessThan(5);
  await expectPlaying("Second", "Serial (2021) · S01E02");

  // Within them it goes to the episode before.
  await press(previous);
  await expectPlaying("Pilot", "Serial (2021) · S01E01");
  // The first episode has none before it, so Previous can only start it over.
  await press(previous);
  await expectPlaying("Pilot", "Serial (2021) · S01E01");

  await press(next);
  await expectPlaying("Second", "Serial (2021) · S01E02");
  // The next episode can be the first of the next season.
  await press(next);
  await expectPlaying("Return", "Serial (2022) · S02E01");
  await page.mouse.move(pointer, pointer);
  await expect(previous).toBeVisible();
  await expect(next).toHaveCount(0);
  await testInfo.attach("player on the last episode", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("an episode that plays through is followed by the next", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await signIn(page);
  await page.goto("/web/library");
  await page.getByRole("button", { name: "Play Serial" }).first().click({ force: true });
  await page.getByRole("button", { name: "Play Season 1" }).first().click({ force: true });
  await play(page, "Pilot");
  const player = page.getByRole("region", { name: "Media player" });
  const upNext = page.getByRole("complementary", { name: "Up next" });
  const currentTime = () => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);

  // The fixture is shorter than the notice, so what follows is announced from the start.
  await page.mouse.move(300, 300);
  await expect(upNext).toContainText("Up next · S01E02");
  await expect(upNext).toContainText("Second");
  await expect(upNext).toContainText(/Plays in \d+ seconds?/u);
  await expect
    .poll(() => upNext.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await testInfo.attach("up next above the controls", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  // The notice outlasts the controls, which hide while the pointer rests.
  await expect(page.locator(".media-player-console")).toBeHidden({ timeout: 10_000 });
  await expect(upNext).toBeVisible();
  await testInfo.attach("up next with the controls hidden", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await page.keyboard.press("ArrowRight");
  await expect(player.getByRole("heading", { name: "Second" })).toBeVisible({ timeout: 20_000 });
  await expect(player.getByText("Serial (2021) · S01E02")).toBeVisible();
  await expect.poll(currentTime).toBeGreaterThan(0.2);
  expect(await currentTime()).toBeLessThan(8);

  // The viewer need not wait for the end.
  await upNext.getByRole("button", { name: "Start now" }).click();
  await expect(player.getByRole("heading", { name: "Return" })).toBeVisible();
  await expect.poll(currentTime).toBeGreaterThan(0.2);
  // Nothing follows the last episode.
  await expect(upNext).toHaveCount(0);
});

test("a watch group moves on to the next episode together", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.locator(".watch-group-trigger").click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Name").fill("Series night");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.locator(".watch-group-trigger.is-active")).toBeVisible();
  await page.keyboard.press("Escape");

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await signIn(guest);
  await guest.locator(".watch-group-trigger").click();
  await guest.getByRole("button", { name: /Series night/u }).click();
  await expect(guest.locator(".watch-group-trigger.is-active")).toBeVisible();
  await guest.keyboard.press("Escape");

  // Membership lives in this page, so reach the show without loading another.
  await page.getByRole("link", { name: "Movies", exact: true }).click();
  await page.getByRole("button", { name: "Play Serial" }).first().click({ force: true });
  await page.getByRole("button", { name: "Play Season 1" }).first().click({ force: true });
  await play(page, "Pilot");
  // The group brings its other member to the player, where the browser wants a click.
  const guestPlayer = guest.getByRole("region", { name: "Media player" });
  await expect(guestPlayer).toBeVisible();
  const start = guest.getByRole("button", { name: "Play", exact: true });
  await expect(start.or(guest.locator('.media-player[data-status="ready"]')).first()).toBeVisible();
  if (await start.isVisible()) await start.click();
  const members = [page, guest];
  const currentTime = (member: Page) =>
    member.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  const expectPlaying = async (title: string): Promise<void> => {
    for (const member of members) {
      await expect(
        member.getByRole("region", { name: "Media player" }).getByRole("heading", { name: title }),
      ).toBeVisible({ timeout: 25_000 });
      await expect.poll(() => currentTime(member), { timeout: 15_000 }).toBeGreaterThan(0.2);
    }
  };
  await expectPlaying("Pilot");
  await page.mouse.move(300, 300);
  await page.keyboard.press("ArrowRight");

  // Both players reach the end and both ask for what follows; the group starts it once.
  await expectPlaying("Second");
  for (const member of members)
    await expect.poll(() => currentTime(member), { timeout: 15_000 }).toBeGreaterThan(4);
  const positions = await Promise.all(members.map(currentTime));
  expect(Math.abs((positions[0] ?? 0) - (positions[1] ?? 0))).toBeLessThan(2);
  await guest.mouse.move(300, 300);
  await testInfo.attach("up next in a watch group", {
    body: await guest.screenshot(),
    contentType: "image/png",
  });

  // One member starting the next episode early starts it for everyone.
  await guest.getByRole("button", { name: "Start now" }).click();
  await expectPlaying("Return");
  await guestContext.close();
});

test("clicking the video toggles playback without taking focus", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  const paused = () => page.evaluate(() => document.querySelector("video")?.paused);

  // A restored position can be nonzero before loading finishes and the hit target is active.
  await expect(page.locator('.media-player[data-status="ready"]')).toBeVisible();
  await expect.poll(paused).toBe(false);
  await page.mouse.move(700, 400);
  await expect(page.getByRole("button", { name: "Pause playback" })).toBeVisible();
  await page.mouse.click(700, 400);
  await expect.poll(paused).toBe(true);
  await expect(page.getByRole("button", { name: "Resume playback" })).toBeVisible();
  // A key press is what turns a pointer-given focus into a visible focus ring.
  await page.keyboard.press("Space");
  await expect.poll(paused).toBe(false);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  await testInfo.attach("player after click", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("double-clicking the video toggles fullscreen without pausing", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  await expect(page.getByRole("button", { name: "Pause playback" })).toBeEnabled();
  await page.evaluate(() => {
    const video = document.querySelector("video");
    if (video === null) throw new Error("Playback did not mount a video");
    video.dataset.pauseCount = "0";
    video.addEventListener("pause", () => {
      video.dataset.pauseCount = String(Number(video.dataset.pauseCount) + 1);
    });
  });
  const currentTime = () => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  const isFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);

  for (const fullscreen of [true, false]) {
    const before = await currentTime();
    await page.mouse.dblclick(700, 400);
    await expect.poll(isFullscreen).toBe(fullscreen);
    // Playback must keep advancing beyond the single-click delay, without even a transient pause.
    await expect.poll(currentTime).toBeGreaterThan(before + 0.5);
    expect(await page.evaluate(() => document.querySelector("video")?.dataset.pauseCount)).toBe(
      "0",
    );
  }
});

test("the show drawer opens at the playing episode and plays another", async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto("/web/library");
  // A show and its seasons have nothing of their own to play, so their play buttons open them.
  await page.getByRole("button", { name: "Play Harbor Lights" }).click({ force: true });
  await page.getByRole("button", { name: "Play Season 1" }).click({ force: true });
  await play(page, "Signal Fire");

  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Episodes" });
  await expect(drawer.getByRole("heading", { name: "Harbor Lights" })).toBeVisible();
  // Both seasons are listed, and the list rests on the episode that is playing.
  await expect(drawer.getByRole("article")).toHaveCount(10);
  const current = drawer.locator('[aria-current="true"]');
  await expect(current).toContainText("Signal Fire");
  await expect(current).toContainText("S1 E5 · Now playing");
  await expect(current).toBeInViewport({ ratio: 1 });
  expect(
    await drawer.locator(".show-drawer-body").evaluate((body) => body.scrollTop),
  ).toBeGreaterThan(0);
  await testInfo.attach("show drawer", { body: await page.screenshot(), contentType: "image/png" });

  // The controls stay for as long as the drawer is open.
  await page.waitForTimeout(3_500);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: "Play Storm Glass" }).click({ force: true });
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("heading", { name: "Storm Glass" })).toBeVisible();
  await expect(page.getByText("Harbor Lights · S02E03")).toBeVisible();
  await waitUntilPlaying(page);

  // Escape closes the drawer, and so does a click on the video beside it.
  await page.mouse.move(320, 320);
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await expect(drawer.locator('[aria-current="true"]')).toContainText("Storm Glass");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await page.mouse.click(400, 400);
  await expect(drawer).toBeHidden();
  expect(await page.evaluate(() => document.querySelector("video")?.paused)).toBe(false);
});

test("the show drawer's episodes are loaded with the player", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/library");
  await page.getByRole("button", { name: "Play Harbor Lights" }).click({ force: true });
  await page.getByRole("button", { name: "Play Season 1" }).click({ force: true });
  // The show and each of its two seasons are read once the player knows what is playing.
  let episodeLists = 0;
  page.on("response", (response) => {
    if (/\/items\/[^/]+\/children/u.test(response.url()) && page.url().endsWith("/web/player"))
      episodeLists += 1;
  });
  await play(page, "Signal Fire");
  await expect.poll(() => episodeLists).toBe(3);

  // Nothing the drawer asks for is answered from here on, so what it lists was already loaded.
  await page.route("**/api/v1/items/*/children*", () => undefined);
  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  const drawer = page.getByRole("complementary", { name: "Episodes" });
  await expect(drawer.getByRole("article")).toHaveCount(10);
  await expect(drawer.locator('[aria-current="true"]')).toBeInViewport({ ratio: 1 });
  await expect(drawer.getByRole("status")).toHaveCount(0);

  // Reopening it is no different.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.getByRole("button", { name: "Episodes", exact: true }).click();
  await expect(drawer.getByRole("article")).toHaveCount(10);
  await expect(drawer.getByRole("status")).toHaveCount(0);
});

test("a film's player has no show drawer", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  await page.mouse.move(300, 300);
  await expect(page.getByRole("button", { name: "Watch together" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Episodes", exact: true })).toHaveCount(0);
});

test("the player controls hide once the viewer is done with the settings", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  const player = page.getByRole("region", { name: "Media player" });
  const settings = page.getByRole("button", { name: "Playback settings", exact: true });
  const panel = page.locator(".media-player-settings-panel");

  // Closed again from its own button, which the click leaves focused.
  await settings.click();
  await expect(panel).toBeVisible();
  await settings.click();
  await page.mouse.move(300, 300);
  await expect(player).not.toHaveClass(/controls-visible/u, { timeout: 8_000 });

  // Left open while the pointer rests on the video.
  await page.mouse.move(320, 320);
  await settings.click();
  await expect(panel).toBeVisible();
  await page.mouse.move(300, 300);
  await expect(player).not.toHaveClass(/controls-visible/u, { timeout: 8_000 });
  await page.mouse.move(320, 320);
  await expect(player).toHaveClass(/controls-visible/u);
  await expect(panel).toBeHidden();
});

test("playback info opens from the settings and stays over the video at the top left", async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto("/web/library");
  await playFilm(page);
  const player = page.getByRole("region", { name: "Media player" });
  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await page.getByRole("button", { name: "Playback info", exact: true }).click();
  await expect(page.locator(".media-player-settings-panel")).toBeHidden();

  const info = page.getByRole("complementary", { name: "Playback info" });
  await expect(info).toContainText("Direct playing");
  await expect(info.getByRole("heading", { name: "Original media info" })).toBeVisible();
  await expect(info).toContainText("Video resolution");
  const box = await info.boundingBox();
  const viewport = page.viewportSize();
  expect(
    box !== null && viewport !== null && box.x < viewport.width / 4 && box.y < viewport.height / 4,
  ).toBe(true);

  // Still there to read once the controls have hidden.
  await page.mouse.move(320, 320);
  await expect(player).not.toHaveClass(/controls-visible/u, { timeout: 8_000 });
  await expect(info).toBeVisible();
  await testInfo.attach("playback info over the film", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await info.getByRole("button", { name: "Close playback info" }).click();
  await expect(info).toBeHidden();
});

test("a watch group's film starts playing in the browser", async ({ page }) => {
  await signIn(page);
  await page.locator(".watch-group-trigger").click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Name").fill("Movie night");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.locator(".watch-group-trigger.is-active")).toBeVisible();
  await page.keyboard.press("Escape");

  // Membership lives in this page, so reach the library without loading another.
  await page.getByRole("link", { name: "Movies", exact: true }).click();
  await playFilm(page);
  await expect.poll(() => page.evaluate(() => document.querySelector("video")?.paused)).toBe(false);

  // Each member is shown how much of the film their player holds.
  await page.mouse.move(400, 400);
  await page.getByRole("button", { name: "Movie night, 1 person" }).click();
  await expect(page.locator(".watch-group-members .watch-group-buffer")).toContainText("buffered", {
    timeout: 10_000,
  });
});

test("older servers keep settings usable without requesting unsupported track memory endpoints", async ({
  page,
}) => {
  const unsupportedRequests: string[] = [];
  await page.route("**/api/v1/server", async (route) => {
    const response = await route.fetch();
    const identity = await response.json();
    delete identity.capabilities.trackMemory;
    await route.fulfill({ response, json: identity });
  });
  for (const path of [
    "**/api/v1/me/track-preferences",
    "**/api/v1/playback/sessions/*/track-choice",
  ])
    await page.route(path, async (route) => {
      unsupportedRequests.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 404, json: { message: "Not found" } });
    });
  await signIn(page);
  await page.goto("/web/settings");
  await expect(
    page.getByText("This server does not support saved audio and subtitle settings."),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Preferred audio language" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Preferred subtitles" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Server" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("This server does not support saved audio and subtitle settings."),
  ).toBeVisible();
  expect(unsupportedRequests).toEqual([]);
});

test("audio and subtitle settings persist after reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/web/settings");
  const audio = page.getByRole("combobox", { name: "Preferred audio language" });
  const subtitles = page.getByRole("combobox", { name: "Preferred subtitles" });
  await expect(audio).toContainText("English");
  await expect(subtitles).toContainText("Off");
  await audio.click();
  await page.getByRole("option", { name: "Japanese", exact: true }).click();
  await expect(audio).toContainText("Japanese");
  await subtitles.click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(subtitles).toContainText("English");
  await page.reload();
  await expect(audio).toContainText("Japanese");
  await expect(subtitles).toContainText("English");
  // Restore the shared fixture's preferences for the next browser project.
  await audio.click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(audio).toContainText("English");
  await subtitles.click();
  await page.getByRole("option", { name: "Off", exact: true }).click();
  await expect(subtitles).toContainText("Off");
});

test("a show's settings keep the TMDb match and episode order in tabs with one action each", async ({
  page,
}) => {
  // The fixture server has no TMDb key, so TMDb's answers are stubbed in the browser.
  const saved: string[] = [];
  await page.route(/\/api\/v1\/items\/[^/]+$/u, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), metadataProviderConfigured: true },
    });
  });
  await page.route(/\/api\/v1\/items\/[^/]+\/match/u, (route) => {
    if (route.request().method() === "PUT") {
      saved.push(`match ${route.request().postDataJSON().tmdbId}`);
      return route.fulfill({ json: { runId: "00000000-0000-4000-8000-000000000001" } });
    }
    return route.fulfill({
      json: {
        tmdbId: "1399",
        query: "Serial",
        candidates: [
          { tmdbId: "1399", title: "Serial", year: 2021, overview: "", posterUrl: null },
          {
            tmdbId: "71912",
            title: "Serial Experiments Lain",
            year: 1998,
            overview: "",
            posterUrl: null,
          },
        ],
      },
    });
  });
  await page.route(/\/api\/v1\/items\/[^/]+\/episode-order/u, (route) => {
    if (route.request().method() === "PUT") {
      saved.push(`order ${route.request().postDataJSON().groupId}`);
      return route.fulfill({ json: { runId: "00000000-0000-4000-8000-000000000002" } });
    }
    return route.fulfill({
      json: {
        tmdbSeriesId: "1399",
        groupId: null,
        groups: [
          { id: "5b11ba820e0a265abc008b8d", name: "DVD Order", description: "", type: "DVD" },
        ],
      },
    });
  });
  // The refresh stays running, so its progress stays on screen.
  await page.route(/\/api\/v1\/scans\//u, () => undefined);

  await signIn(page);
  await page.goto("/web/library");
  await page.getByRole("button", { name: "Serial Serial 2021" }).first().click();
  await page.getByRole("button", { name: "Show settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Show settings" });
  const match = dialog.getByRole("region", { name: "TMDb match" });
  const order = dialog.getByRole("region", { name: "Episode order" });
  await expect(match).toBeVisible();
  await expect(order).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

  const current = match.getByRole("button", { name: /^Serial 2021 Current/u });
  await expect(current).toHaveAttribute("aria-pressed", "true");
  await expect(current).toContainText("Current");
  const useMatch = match.getByRole("button", { name: "Use this match" });
  await expect(useMatch).toBeDisabled();
  await match.getByRole("button", { name: /Serial Experiments Lain/u }).click();
  await expect(current).toHaveAttribute("aria-pressed", "false");
  await useMatch.click();
  await expect(match.getByRole("status")).toHaveText("Saved. Refreshing details from TMDb…");

  await dialog.getByRole("tab", { name: "Episode order" }).click();
  await expect(match).toBeHidden();
  await expect(order.getByRole("button", { name: /^Default order/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // A change is not saved over a refresh that is still applying the last one.
  await expect(order.getByRole("button", { name: "Save order" })).toBeDisabled();
  await expect(order.getByRole("status")).toHaveText("Saved. Refreshing details from TMDb…");
  expect(saved).toEqual(["match 71912"]);
});
