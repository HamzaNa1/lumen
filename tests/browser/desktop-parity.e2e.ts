import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
  type TestInfo,
} from "@playwright/test";
import type { ParityScenario } from "./desktopBridgeShim";

// Renders the desktop renderer build and the web build side by side — same server, same data,
// same account, same viewport, same browser engine — and requires what they share to come out
// alike pixel for pixel, apart from the few corner pixels a software renderer paints unevenly.
// The desktop renderer runs here in a browser behind a stand-in for its Electron bridge, so this
// proves the builds draw the same pages, forms, menus and controls; it does not exercise
// Electron's window chrome or the native player.
//
// The browser test command also builds the renderer from before the extraction. Today's
// desktop build is held against that fixed reference. Both run behind the same stand-in,
// so their whole windows are compared.

const repository = fileURLToPath(new URL("../../", import.meta.url));
const desktopRenderer = join(repository, "apps/desktop/out/renderer");
const baselineRenderer = join(repository, "apps/desktop/out/renderer-baseline");
const hasBaseline = existsSync(join(baselineRenderer, "index.html"));
const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

/** A desktop renderer build, and where the test server's origin pretends to serve it from. */
interface DesktopBuild {
  readonly files: string;
  readonly base: string;
}
const desktopBuild: DesktopBuild = { files: desktopRenderer, base: "/desktop-renderer" };
const baselineBuild: DesktopBuild = { files: baselineRenderer, base: "/desktop-baseline" };

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "One engine is enough to compare builds",
);
test.skip(!existsSync(join(desktopRenderer, "index.html")), "Build the desktop renderer first");
// The desktop renderer's document is supplied by the test, not loaded from the server, and the
// browser will not let such a page open a socket to a local address unless told it may.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });

let shim = "";
test.beforeAll(() => {
  expect(
    hasBaseline,
    "Build the pre-extraction renderer with `bun run test:browser:baseline`",
  ).toBe(true);
  const output = join(mkdtempSync(join(tmpdir(), "lumen-parity-")), "bridge.js");
  execFileSync(
    "bun",
    ["build", "tests/browser/desktopBridgeShim.ts", "--outfile", output, "--target", "browser"],
    { cwd: repository, stdio: "pipe" },
  );
  shim = readFileSync(output, "utf8");
});

const signIn = async (context: BrowserContext, baseURL: string): Promise<void> => {
  const response = await context.request.post("/api/v1/auth/browser/login", {
    headers: { origin: baseURL, "x-lumen-csrf": "1" },
    data: {
      username: "admin",
      password: "correct horse battery staple",
      deviceId: crypto.randomUUID(),
      deviceName: "Parity test",
    },
  });
  expect(response.status()).toBe(200);
};

/** A page in a browser that has no session with the server. */
const newSignedOutPage = async (browser: Browser, baseURL: string): Promise<Page> => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 920 } });
  return context.newPage();
};

/** A desktop renderer's files, served from the test server's origin so it can reach the API. */
const openDesktop = async (context: BrowserContext, build: DesktopBuild): Promise<Page> => {
  const page = await context.newPage();
  await page.route(`**${build.base}/**`, async (route) => {
    const file = join(
      build.files,
      new URL(route.request().url()).pathname.slice(build.base.length),
    );
    await route.fulfill({
      body: readFileSync(file),
      contentType: contentTypes[extname(file)] ?? "application/octet-stream",
    });
  });
  await page.addInitScript(shim);
  return page;
};

/** Loads a route of a desktop build from a fresh document, with the bridge reporting `scenario`. */
const gotoDesktop = async (
  page: Page,
  build: DesktopBuild,
  route: string,
  scenario: ParityScenario & { readonly overlay?: boolean } = {},
): Promise<void> => {
  const { overlay = false, ...reported } = scenario;
  const query = new URLSearchParams();
  if (Object.keys(reported).length > 0) query.set("scenario", JSON.stringify(reported));
  if (overlay) query.set("overlay", "1");
  const search = query.size === 0 ? "" : `?${query.toString()}`;
  await page.goto(`${build.base}/index.html${search}#${route}`);
  // Changing only the hash navigates inside the running page. Reload so that every build
  // draws the route from a fresh document.
  await page.reload();
};

// Without a GPU, as on CI, the browser does not antialias a rounded corner identically every
// time it paints: two pictures of the same page can disagree on three or four corner pixels,
// on a different page from one run to the next. Anything a build could actually get wrong,
// such as a missing icon, shifted text or a changed colour, alters hundreds of pixels at least.
const RASTER_NOISE_PIXELS = 16;

/** How many pixels differ between two PNGs, counted by the browser so no decoder is needed. */
const differingPixels = (page: Page, first: Buffer, second: Buffer): Promise<number> =>
  page.evaluate(
    async ([a, b]) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("No 2D context");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [left, right] = await Promise.all([decode(a), decode(b)]);
      if (left.width !== right.width || left.height !== right.height)
        return Number.MAX_SAFE_INTEGER;
      let differing = 0;
      for (let index = 0; index < left.data.length; index += 4)
        if (
          left.data[index] !== right.data[index] ||
          left.data[index + 1] !== right.data[index + 1] ||
          left.data[index + 2] !== right.data[index + 2] ||
          left.data[index + 3] !== right.data[index + 3]
        )
          differing += 1;
      return differing;
    },
    [first.toString("base64"), second.toString("base64")] as const,
  );

const STILL =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/** Waits until a page showing `landmark` has finished loading and nothing is still moving. */
const settled = async (page: Page, landmark = ".main-content"): Promise<void> => {
  await expect(page.locator(landmark).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".spinner, [class*='skeleton']")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  // Nothing should still be easing into place when the picture is taken.
  await page.addStyleTag({ content: STILL });
};

type Region = string | ((page: Page) => Locator);
const locate = (page: Page, region: Region): Locator =>
  typeof region === "string" ? page.locator(region) : region(page);

interface Side {
  readonly build: string;
  readonly page: Page;
}

/**
 * Draws a region afresh. A browser that repaints only part of a region can leave the
 * anti-aliased edges of what it kept a shade off. That is a difference between two paints of
 * one page, not between two builds, and it stays until the region is next drawn in full.
 */
const repaint = (page: Page, selector: string): Promise<void> =>
  page.evaluate(async (selector) => {
    const region = document.querySelector<HTMLElement>(selector);
    if (region === null) throw new Error(`Nothing to repaint at ${selector}`);
    const painted = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    region.style.display = "none";
    await painted();
    region.style.display = "";
    await painted();
  }, selector);

/** Requires one region to look the same in two builds. */
const expectAlike = async (
  testInfo: TestInfo,
  name: string,
  region: Region,
  [first, second]: readonly [Side, Side],
  {
    before = async () => undefined,
    style,
  }: {
    /** Runs before each picture, for state that fades unless it is kept alive. */
    readonly before?: (page: Page) => Promise<void>;
    /** Applied only while the pictures are taken, to leave out what differs by design. */
    readonly style?: string;
  } = {},
): Promise<void> => {
  // Some content arrives without a loading indicator to wait on (a library's folders, for
  // one), so the two pages may briefly be at different stages. A real difference between
  // the builds never goes away, so keep comparing until they agree or time runs out.
  let shots: readonly [Buffer, Buffer] = [Buffer.alloc(0), Buffer.alloc(0)];
  const matches = async (): Promise<boolean> => {
    await Promise.all([before(first.page), before(second.page)]);
    shots = await Promise.all([
      locate(first.page, region).screenshot({ style }),
      locate(second.page, region).screenshot({ style }),
    ]);
    return (
      shots[0].equals(shots[1]) ||
      (await differingPixels(first.page, shots[0], shots[1])) <= RASTER_NOISE_PIXELS
    );
  };
  const label = typeof region === "string" ? region : "region";
  try {
    await expect
      .poll(matches, {
        message: `${name}: ${label} differs between ${first.build} and ${second.build}`,
        timeout: 10_000,
      })
      .toBe(true);
  } catch (cause) {
    // Keep both pictures so a difference can be looked at, not just reported.
    for (const [side, shot] of [
      [first, shots[0]],
      [second, shots[1]],
    ] as const) {
      const file = `${name}-${label}-${side.build}.png`.replace(/[^\w.-]+/gu, "-");
      const path = testInfo.outputPath(file);
      writeFileSync(path, shot);
      await testInfo.attach(`${name} ${label} ${side.build}`, { path, contentType: "image/png" });
    }
    throw cause;
  }
};

interface Builds {
  readonly web: Side;
  readonly desktop: Side;
  /** The desktop renderer from before the extraction, when it has been built. */
  readonly baseline: Side | null;
  /** Every desktop build with the files it is served from. */
  readonly desktops: ReadonlyArray<Side & { readonly files: DesktopBuild }>;
}

const openBuilds = async (context: BrowserContext): Promise<Builds> => {
  const web = { build: "web", page: await context.newPage() };
  const desktop = {
    build: "desktop",
    page: await openDesktop(context, desktopBuild),
    files: desktopBuild,
  };
  const baseline = hasBaseline
    ? { build: "baseline", page: await openDesktop(context, baselineBuild), files: baselineBuild }
    : null;
  return { web, desktop, baseline, desktops: baseline === null ? [desktop] : [desktop, baseline] };
};

/** The whole window, for two builds that run behind the same bridge stand-in. */
const expectDesktopUnchanged = async (
  testInfo: TestInfo,
  name: string,
  { desktop, baseline }: Builds,
  options?: Parameters<typeof expectAlike>[4],
): Promise<void> => {
  if (baseline !== null) await expectAlike(testInfo, name, "body", [desktop, baseline], options);
};

const signedInBuilds = async (context: BrowserContext, baseURL: string): Promise<Builds> => {
  await signIn(context, baseURL);
  return openBuilds(context);
};

test("the desktop and web builds draw the shared pages identically", async ({
  context,
  baseURL,
}, testInfo) => {
  const builds = await signedInBuilds(context, baseURL ?? "");
  const { web, desktop } = builds;
  const libraries = (await (await context.request.get("/api/v1/libraries")).json()) as {
    id: string;
  }[];
  const libraryId = libraries[0]?.id ?? "";
  const items = (await (
    await context.request.get(`/api/v1/items?libraryId=${libraryId}&limit=50`)
  ).json()) as { items: { id: string; title: string }[] };
  const film = items.items.find((item) => item.title === "Film")?.id ?? "";
  expect(film).not.toBe("");

  const routes = [
    ["home", "/"],
    ["library index", "/library"],
    ["library", `/library/${libraryId}`],
    ["movie details", `/item/${film}`],
    ["search", "/search?q=Film"],
    ["settings", "/settings"],
    ["administration", "/admin"],
    ["users", "/admin/users"],
    ["job log", "/admin/jobs"],
  ] as const;

  for (const [name, route] of routes) {
    await web.page.goto(`/web${route}`);
    for (const { page, files } of builds.desktops) await gotoDesktop(page, files, route);
    await settled(web.page);
    for (const { page } of builds.desktops) await settled(page);
    // Every router must have ended up in the same place, including after any redirect.
    const webRoute = await web.page.evaluate(() =>
      (location.pathname + location.search).replace(/^\/web/u, ""),
    );
    for (const { page } of builds.desktops)
      await expect.poll(() => page.evaluate(() => window.location.hash.slice(1))).toBe(webRoute);

    // Navigation is shared; the account menu beneath it differs by design and is left out.
    await expectAlike(testInfo, name, ".nav", [web, desktop]);
    // The users page has listed each account's libraries only since the baseline was taken, and
    // settings has traded the rows that only reported things for playback preferences since then.
    // Movies have had a settings button only since the baseline was taken.
    if (name !== "users" && name !== "settings")
      await expectDesktopUnchanged(
        testInfo,
        name,
        builds,
        name === "movie details"
          ? { style: ".details-icon-button { display: none !important; }" }
          : undefined,
      );
    if (name !== "settings") {
      await expectAlike(testInfo, name, ".main-content", [web, desktop]);
      continue;
    }
    // Settings is the one page meant to differ: only the desktop can switch servers, so only its
    // card continues below the server. Everything above that must still be drawn the same.
    for (const row of ["Preferred audio", "Preferred subtitles"])
      await expectAlike(
        testInfo,
        `settings ${row}`,
        (page) => page.locator(".settings-row").filter({ hasText: row }),
        [web, desktop],
      );
    await expectAlike(
      testInfo,
      "settings server",
      (page) => page.getByRole("region", { name: "Server" }).locator(".settings-row-text"),
      [web, desktop],
    );
    for (const { page } of [web, desktop]) {
      await expect(page.getByRole("combobox", { name: "Preferred audio language" })).toHaveText(
        "English",
      );
      await expect(page.getByRole("combobox", { name: "Preferred subtitles" })).toHaveText("Off");
    }
    await expect(desktop.page.getByRole("button", { name: "Switch server…" })).toBeVisible();
    await expect(web.page.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
  }

  // The account menu lists servers only where servers can be switched, so the web build's is
  // shorter by design; the desktop's must be what it was.
  for (const { page } of [web, ...builds.desktops]) {
    await page.locator(".account-trigger").click();
    await expect(page.locator(".account-menu")).toBeVisible();
  }
  await expectAlike(testInfo, "account trigger", ".account-trigger", [web, desktop]);
  await expectAlike(testInfo, "shared account menu", ".account-menu", [web, desktop], {
    style:
      ".account-menu > [role='group'], .account-menu > .menu-separator, .account-menu > .menu-item:has(.lucide-plus) { display: none !important; }",
  });
  await expect(web.page.getByRole("menuitem", { name: "Add server…" })).toHaveCount(0);
  await expect(desktop.page.getByRole("menuitem", { name: "Add server…" })).toBeVisible();
  await expectDesktopUnchanged(testInfo, "account menu", builds);
});

test("the connection forms are drawn identically", async ({
  browser,
  context,
  baseURL,
}, testInfo) => {
  const builds = await signedInBuilds(context, baseURL ?? "");
  const { desktop } = builds;
  // The web build signs in to the server it was loaded from, so it has no address form.
  for (const { page, files } of builds.desktops) {
    await gotoDesktop(page, files, "/", { signedOut: true });
    await settled(page, ".connect-form");
  }
  // The baseline still asks the viewer to name the server, which now names itself.
  await expectDesktopUnchanged(testInfo, "server address form", builds, {
    style: '.connect-form > :has(input[placeholder="Living room"]) { display: none !important; }',
  });

  for (const { page } of builds.desktops) {
    await page.getByLabel("Server address").fill(baseURL ?? "");
    await page.getByRole("button", { name: "Continue" }).click();
    // The button sits higher without the baseline's name field, so the pointer it leaves
    // behind would rest on a different part of the next form in each build.
    await page.mouse.move(0, 0);
    await page.getByLabel("Username").focus();
  }
  // The baseline still offers to create an account on a server that is already set up, and
  // shows the name typed on the device where the server's own name now appears.
  await expectDesktopUnchanged(testInfo, "sign-in form", builds, {
    style:
      ".connect-switch { display: none !important; } .server-chip strong, .connect-heading p { visibility: hidden !important; }",
  });

  const signedOut = await newSignedOutPage(browser, baseURL ?? "");
  try {
    const web = { build: "web", page: signedOut };
    await signedOut.goto("/web/");
    await settled(signedOut, ".connect-form");
    await signedOut.getByLabel("Username").focus();
    // Only the desktop offers to change the server.
    const style = ".server-chip { visibility: hidden !important; }";
    await expectAlike(testInfo, "sign-in form", ".connect-form", [web, desktop], { style });
    await expect(signedOut.getByRole("button", { name: "Create an account" })).toHaveCount(0);
  } finally {
    await signedOut.context().close();
  }
});

test("switching accounts keeps the new account's libraries subscribed", async ({
  context,
  baseURL,
}) => {
  await signIn(context, baseURL ?? "");
  const page = await openDesktop(context, desktopBuild);
  await page.addInitScript(() => {
    const bridge = window.lumen;
    const initial = bridge.accounts.list();
    let activeId: string | null = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { requested: false, completed: false, release };
    Reflect.set(window, "accountSwitchTest", state);
    const records = initial.then(({ accounts }) => {
      const first = accounts[0];
      if (first === undefined) throw new Error("Sign in before switching accounts");
      activeId = first.connectionId;
      return [
        first,
        {
          ...first,
          connectionId: "replacement",
          userId: "replacement-user",
          username: "replacement",
          serverName: "Replacement",
        },
      ];
    });
    Object.assign(bridge.accounts, {
      list: async () => ({ accounts: await records, activeConnectionId: activeId }),
      activate: async (id: string) => {
        await records;
        activeId = id;
        return bridge.accounts.list();
      },
    });
    Object.assign(bridge.library, {
      list: async () => {
        await records;
        const replacing = activeId === "replacement";
        if (replacing) {
          state.requested = true;
          await gate;
          state.completed = true;
        }
        return [
          {
            id: replacing ? "new-library" : "old-library",
            name: replacing ? "Replacement library" : "Original library",
            slug: "movies",
            kind: "movies",
            isEnabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ];
      },
    });
  });
  await gotoDesktop(page, desktopBuild, "/settings");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Original library" })).toBeVisible();
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /Replacement/u }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "accountSwitchTest").requested))
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, "accountSwitchTest").release());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "accountSwitchTest").completed))
    .toBe(true);
  await expect(nav.getByRole("link", { name: "Replacement library" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Original library" })).toHaveCount(0);
  // Repeating the transition must retain the new subscription each time.
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /admin ·/u }).click();
  await expect(nav.getByRole("link", { name: "Original library" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Replacement library" })).toHaveCount(0);
});

test("a downloaded update offers a restart that installs it", async ({
  context,
  baseURL,
}) => {
  await signIn(context, baseURL ?? "");
  const page = await openDesktop(context, desktopBuild);
  await page.addInitScript(() => {
    Object.assign(window.lumen.updates, {
      ready: async () => "0.0.13",
      install: async () => {
        Reflect.set(window, "updateInstallRequested", true);
      },
    });
  });
  await gotoDesktop(page, desktopBuild, "/");
  const prompt = page.getByRole("alert").filter({ hasText: "Lumen 0.0.13 is ready" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Restart" }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "updateInstallRequested")))
    .toBe(true);
});

test("watch groups are drawn identically", async ({ context, baseURL }, testInfo) => {
  const builds = await signedInBuilds(context, baseURL ?? "");
  const { web, desktop } = builds;
  const pages = [web.page, ...builds.desktops.map((side) => side.page)];
  await web.page.goto("/web/");
  for (const { page, files } of builds.desktops) await gotoDesktop(page, files, "/");
  for (const page of pages) await settled(page);

  const compare = async (name: string): Promise<void> => {
    // A control that appears under a pointer left where it last clicked may or may not be
    // drawn as hovered, so the pointer is moved off the panel first.
    for (const page of pages) await page.mouse.move(700, 300);
    // The sidebar redraws in pieces as a group comes and goes, and not in the same pieces in
    // every build.
    for (const page of pages) await repaint(page, ".sidebar");
    await expectAlike(testInfo, name, ".watch-group-panel", [web, desktop]);
    await expectAlike(testInfo, name, ".watch-group-trigger", [web, desktop]);
    await expectDesktopUnchanged(testInfo, name, builds);
  };

  for (const page of pages) {
    await page.locator(".watch-group-trigger").click();
    await expect(page.getByText("No groups yet")).toBeVisible();
  }
  await compare("no watch groups");

  for (const page of pages) {
    await page.getByRole("button", { name: "New group" }).click();
    await page.getByLabel("Name").fill("Movie night");
    await page.getByLabel("Password").fill("together");
  }
  await compare("new watch group form");

  // Each build starts a group of its own, so each sees one member: itself.
  for (const page of pages) {
    await page.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByText("1 person")).toBeVisible();
  }
  await compare("active watch group");

  for (const page of pages) await page.getByRole("button", { name: "Leave" }).click();
  // The other builds' groups disappear from the list as they leave too.
  for (const page of pages) await expect(page.getByText("No groups yet")).toBeVisible();
  await compare("left watch group");
});

const filmDisplay = {
  title: "Film",
  context: "",
  duration: 100,
  hasPreviousEpisode: false,
  nextEpisode: null,
} as const;
const playing: NonNullable<ParityScenario["player"]> = {
  sessionId: "session",
  itemId: "item",
  paused: false,
  positionSeconds: 42,
  durationSeconds: 100,
  bufferedRanges: [{ startSeconds: 30, endSeconds: 70 }],
  volume: 60,
  muted: false,
  ended: false,
  streams: [
    {
      id: "a1",
      kind: "audio",
      ordinal: 1,
      codec: "aac",
      language: "eng",
      title: "English",
      isDefault: true,
    },
    {
      id: "a2",
      kind: "audio",
      ordinal: 2,
      codec: "ac3",
      language: "jpn",
      title: "Japanese",
      isDefault: false,
    },
    {
      id: "s1",
      kind: "subtitle",
      ordinal: 3,
      codec: "subrip",
      language: "eng",
      title: "English",
      isDefault: false,
    },
  ],
  selectedAudioStreamId: "a1",
  selectedSubtitleStreamId: null,
  audioOutput: "stereo",
};

test("the desktop player controls are what they were before the extraction", async ({
  context,
  baseURL,
}, testInfo) => {
  test.skip(!hasBaseline, "Build the pre-extraction renderer with `bun run test:browser:baseline`");
  const builds = await signedInBuilds(context, baseURL ?? "");
  // The baseline predates the time playback ends at and the Previous button, which are left out.
  const withoutLaterControls = {
    style:
      ".media-player-ends-at { visibility: hidden !important; } .media-player-transport > [aria-label='Previous'] { display: none !important; }",
  };
  const states: ReadonlyArray<readonly [string, ParityScenario]> = [
    ["starting", { display: { ...filmDisplay, loading: true, error: null } }],
    [
      "failed",
      { display: { ...filmDisplay, loading: false, error: "This file could not be played." } },
    ],
    ["playing", { display: { ...filmDisplay, loading: false, error: null }, player: playing }],
    [
      "paused and muted",
      {
        display: { ...filmDisplay, loading: false, error: null },
        player: { ...playing, paused: true, muted: true },
      },
    ],
  ];
  for (const [name, scenario] of states) {
    for (const { page, files } of builds.desktops) {
      await gotoDesktop(page, files, "/", { ...scenario, overlay: true });
      await expect(page.locator(".media-player")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.addStyleTag({ content: STILL });
    }
    // The loading state keeps its spinner; every other state has to have stopped moving.
    await expectDesktopUnchanged(testInfo, `player ${name}`, builds, withoutLaterControls);
  }

  // The last state is still showing: open its menus.
  for (const { page } of builds.desktops)
    await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  await expect(
    builds.desktop.page.getByRole("button", { name: "Export playback diagnostics", exact: true }),
  ).toBeVisible();
  // Diagnostics now include playback failures. Compare the rest of the menu against the
  // fixed baseline while explicitly accounting for this intentional label change.
  if (builds.baseline !== null) {
    const previousLabel = builds.baseline.page.getByRole("button", {
      name: "Copy audio diagnostics",
      exact: true,
    });
    await expect(previousLabel).toBeVisible();
    await previousLabel.evaluate((button) => {
      button.textContent = "Export playback diagnostics";
    });
    // The menu has since been raised above the sliders it opens over, so its shadow now
    // falls on the volume slider instead of behind it.
    await builds.baseline.page.addStyleTag({
      content: ".media-player-settings-panel { z-index: 3; }",
    });
  }
  await expectDesktopUnchanged(testInfo, "playback settings", builds, withoutLaterControls);
  for (const { page } of builds.desktops) {
    await page.getByRole("button", { name: "Playback settings", exact: true }).click();
    await page.locator(".watch-group-chip").click();
    await expect(page.getByText("No groups yet")).toBeVisible();
  }
  await expectDesktopUnchanged(testInfo, "watch groups in the player", builds, withoutLaterControls);
});

test("the playback settings open over the timeline", async ({ context, baseURL }, testInfo) => {
  const { page } = (await signedInBuilds(context, baseURL ?? "")).desktop;
  // Far enough along that the played part of the timeline, and its thumb, run under the panel.
  await gotoDesktop(page, desktopBuild, "/", {
    overlay: true,
    display: { ...filmDisplay, loading: false, error: null },
    player: { ...playing, positionSeconds: 92 },
  });
  await page.getByRole("button", { name: "Playback settings", exact: true }).click();
  const panel = page.locator(".media-player-settings-panel");
  await expect(panel).toBeVisible();
  await page.addStyleTag({ content: STILL });
  await testInfo.attach("playback settings over the timeline", {
    body: await page.locator(".media-player-console").screenshot(),
    contentType: "image/png",
  });

  const thumb = await page.locator(".media-player-timeline .media-slider-thumb").boundingBox();
  const bounds = await panel.boundingBox();
  if (thumb === null || bounds === null) throw new Error("The timeline or the panel is not drawn");
  const point = { x: thumb.x + thumb.width / 2, y: thumb.y + 1 };
  expect(point.x).toBeGreaterThan(bounds.x);
  expect(point.y).toBeLessThan(bounds.y + bounds.height);
  const topmost = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(".media-player-settings-panel") !== null,
    point,
  );
  expect(topmost, "the settings panel is drawn over the timeline's thumb").toBe(true);
});

test("hovering the timeline shows the time under the pointer", async ({ context, baseURL }, testInfo) => {
  const { page } = (await signedInBuilds(context, baseURL ?? "")).desktop;
  await gotoDesktop(page, desktopBuild, "/", {
    overlay: true,
    display: { ...filmDisplay, duration: 5_400, loading: false, error: null },
    player: { ...playing, positionSeconds: 1_200, durationSeconds: 5_400, bufferedRanges: [] },
  });
  const hover = page.locator(".media-player-timeline-hover");
  const control = await page.locator(".media-player-timeline .media-slider-control").boundingBox();
  if (control === null) throw new Error("The timeline is not drawn");
  const y = control.y + control.height / 2;
  await expect(hover).toHaveCount(0);

  await page.mouse.move(control.x + control.width * 0.75, y);
  await expect(hover).toHaveText("1:07:30");
  const label = await hover.boundingBox();
  if (label === null) throw new Error("The hovered time is not drawn");
  expect(Math.abs(label.x + label.width / 2 - (control.x + control.width * 0.75))).toBeLessThan(2);
  expect(label.y + label.height).toBeLessThanOrEqual(control.y);
  await testInfo.attach("timeline hover", {
    body: await page.locator(".media-player-console").screenshot(),
    contentType: "image/png",
  });

  await page.mouse.move(control.x + control.width * 0.1, y);
  // The pointer lands on a whole pixel, which can fall a moment short of the tenth it aims for.
  await expect(hover).toHaveText(/^(8:59|9:00)$/u);
  await testInfo.attach("timeline hover near the start", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Hovering only previews a time; playback stays where it was.
  await expect(page.locator(".media-player-time").first()).toHaveText("20:00");
  await page.mouse.move(control.x + control.width / 2, control.y - 200);
  await expect(hover).toHaveCount(0);
});

test("the player controls are drawn identically over playing media", async ({
  context,
  baseURL,
}, testInfo) => {
  const builds = await signedInBuilds(context, baseURL ?? "");
  const { web, desktop } = builds;
  await web.page.goto("/web/library");
  await web.page.getByRole("button", { name: "Play Film" }).first().click({ force: true });
  await expect(web.page.getByRole("region", { name: "Media player" })).toBeVisible();
  // Headless browsers refuse unprompted playback with sound; the player then asks for a click.
  const start = web.page.getByRole("button", { name: "Play", exact: true });
  if (await start.isVisible().catch(() => false)) await start.click();
  const video = (): Promise<{
    readonly paused: boolean;
    readonly positionSeconds: number;
    readonly durationSeconds: number;
    readonly bufferedRanges: { startSeconds: number; endSeconds: number }[];
    readonly volume: number;
    readonly muted: boolean;
  } | null> =>
    web.page.evaluate(() => {
      const element = document.querySelector("video");
      if (element === null) return null;
      const bufferedRanges = [];
      for (let index = 0; index < element.buffered.length; index += 1)
        bufferedRanges.push({
          startSeconds: element.buffered.start(index),
          endSeconds: element.buffered.end(index),
        });
      return {
        paused: element.paused,
        positionSeconds: element.currentTime,
        durationSeconds: element.duration,
        bufferedRanges,
        volume: Math.round(element.volume * 100),
        muted: element.muted,
      };
    });
  await expect.poll(async () => (await video())?.positionSeconds ?? 0).toBeGreaterThan(0.2);
  await web.page.mouse.move(300, 300);
  await web.page.getByRole("button", { name: "Pause playback" }).last().click();
  await expect.poll(async () => (await video())?.paused).toBe(true);
  // The whole file is short enough to finish buffering; wait so the picture cannot change.
  await web.page.waitForLoadState("networkidle");
  const element = await video();
  if (element === null) throw new Error("The web build is not playing");

  // The desktop's controls window is told the same thing the browser's player reports.
  const header = web.page.locator(".media-player-title");
  await gotoDesktop(desktop.page, desktopBuild, "/", {
    overlay: true,
    display: {
      title: await header.locator("h1").innerText(),
      context:
        (await header.locator("p").count()) === 0 ? "" : await header.locator("p").innerText(),
      duration: Math.round(element.durationSeconds),
      loading: false,
      error: null,
      hasPreviousEpisode: false,
      nextEpisode: null,
    },
    player: { ...playing, ...element, streams: [], selectedAudioStreamId: null },
  });
  await expect(desktop.page.locator(".media-player")).toBeVisible();

  // The controls sit over the video, which only the browser build draws into the page.
  const withoutVideo = `${STILL} video { visibility: hidden !important; } html, body, #root, .watch-page, .player-overlay { background: #000 !important; }`;
  for (const { page } of [web, desktop]) await page.addStyleTag({ content: withoutVideo });
  // The controls fade once the pointer rests.
  let nudge = 0;
  const keepControls = async (page: Page): Promise<void> => {
    nudge += 1;
    await page.mouse.move(300 + (nudge % 2), 300);
  };
  for (const region of [".media-player-header", ".media-player-console"])
    await expectAlike(testInfo, "paused player", region, [web, desktop], { before: keepControls });

  await web.page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(web.page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});
