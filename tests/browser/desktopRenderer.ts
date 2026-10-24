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
  type TestInfo,
  test,
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
export const hasBaseline = existsSync(join(baselineRenderer, "index.html"));
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
export const desktopBuild: DesktopBuild = { files: desktopRenderer, base: "/desktop-renderer" };
export const baselineBuild: DesktopBuild = { files: baselineRenderer, base: "/desktop-baseline" };

let shim = "";
export const setupDesktopRenderer = () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Desktop renderer parity targets Electron's Chromium engine; cross-browser playback is covered by web-app.e2e.ts",
  );
  test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });
  test.beforeAll(() => {
    expect(
      existsSync(join(desktopRenderer, "index.html")),
      "Build the desktop renderer first",
    ).toBe(true);
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
};

export const signIn = async (context: BrowserContext, baseURL: string): Promise<void> => {
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
export const newSignedOutPage = async (browser: Browser, baseURL: string): Promise<Page> => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 920 } });
  return context.newPage();
};

/** A desktop renderer's files, served from the test server's origin so it can reach the API. */
export const openDesktop = async (context: BrowserContext, build: DesktopBuild): Promise<Page> => {
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
export const gotoDesktop = async (
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

export const STILL =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/** Waits until a page showing `landmark` has finished loading and nothing is still moving. */
export const settled = async (page: Page, landmark = ".main-content"): Promise<void> => {
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
export const repaint = (page: Page, selector: string): Promise<void> =>
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
export const expectAlike = async (
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
      locate(first.page, region).screenshot(style === undefined ? {} : { style }),
      locate(second.page, region).screenshot(style === undefined ? {} : { style }),
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
export const expectDesktopUnchanged = async (
  testInfo: TestInfo,
  name: string,
  { desktop, baseline }: Builds,
  options?: Parameters<typeof expectAlike>[4],
): Promise<void> => {
  if (baseline !== null)
    await expectAlike(testInfo, name, "body", [desktop, baseline], {
      ...options,
      // Episode resume captions were added after this fixed reference (bea411d). They still
      // participate in current web/desktop comparisons, but have no counterpart in the baseline.
      style: [
        ".shelf .media-card-subtitle + .media-card-subtitle { display: none !important; }",
        options?.style,
      ]
        .filter(Boolean)
        .join("\n"),
    });
};

export const signedInBuilds = async (context: BrowserContext, baseURL: string): Promise<Builds> => {
  await signIn(context, baseURL);
  return openBuilds(context);
};

export const filmDisplay = {
  itemId: null,
  title: "Film",
  context: "",
  duration: 100,
  hasPreviousEpisode: false,
  nextEpisode: null,
} as const;
export const playing: NonNullable<ParityScenario["player"]> = {
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
