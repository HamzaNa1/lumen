import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { connectDesktop, expect, launchDesktop, mainDesktopPage, test } from "./support/desktop";
import { latch, NetworkProxy } from "./support/proxy";
import { password } from "./support/server";

interface Ref {
  readonly id: string;
  readonly revision: string | null;
}

const artworkUrl = (ref: Ref, width = 320) =>
  `lumen-artwork://artwork/${ref.id}?width=${width}${ref.revision === null ? "" : `&revision=${ref.revision}`}`;

/** What the renderer gets for an artwork URL, read in the main process past the page's image cache. */
const loadArtwork = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ session }, url) => {
    const response = await session.defaultSession.fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    return response.ok ? bytes.toString("base64") : null;
  }, url);

test("account artwork partitions reject late responses and removing one account clears only its cache", async ({
  server,
  admin,
  desktop,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film/Film.mp4"], {
    "Film/poster.png": "still.png",
  });
  await server.api("/users", {
    token: admin.accessToken,
    body: { username: "viewer", displayName: "Viewer", password, libraryAccess: { scope: "all" } },
  });
  const item = (await server.items(admin.accessToken, library.id))[0];
  const details = await server.api<{ item: { artworkId: string; artworkRevision: string } }>(
    `/items/${item?.id}`,
    { token: admin.accessToken },
  );
  const ref = { id: details.item.artworkId, revision: details.item.artworkRevision };
  const proxy = await new NetworkProxy(server.origin).start();
  const tokens: string[] = [];
  const held = latch();
  const captured = latch();
  let hold = false;
  proxy.intercept = async (request) => {
    if (request.url?.includes("/artwork/")) {
      tokens.push(request.headers.authorization ?? "");
      if (hold) {
        captured.release();
        await held.promise;
      }
    }
    return false;
  };
  const { app, page } = desktop;
  try {
    await connectDesktop(page, proxy);
    const a = (await page.evaluate(() => window.lumen.accounts.list())).activeConnectionId ?? "";
    const image = await loadArtwork(app, artworkUrl(ref));
    expect(image).not.toBeNull();
    const tokenA = tokens.at(-1);
    await page.evaluate(
      (origin) => window.lumen.accounts.discoverServer(origin),
      new URL(proxy.origin).origin,
    );
    const b =
      (
        await page.evaluate(
          ({ origin, password }) =>
            window.lumen.accounts.connect({ origin, username: "viewer", password }),
          { origin: new URL(proxy.origin).origin, password },
        )
      ).activeConnectionId ?? "";
    expect(b).not.toBe(a);
    const beforeB = tokens.length;
    expect(await loadArtwork(app, artworkUrl(ref))).toBe(image);
    expect(tokens.length).toBeGreaterThan(beforeB);
    expect(tokens.at(-1)).not.toBe(tokenA);
    await page.evaluate((id) => window.lumen.accounts.activate(id), a);
    const beforeA = tokens.length;
    expect(await loadArtwork(app, artworkUrl(ref))).toBe(image);
    expect(tokens).toHaveLength(beforeA);
    hold = true;
    const pending = loadArtwork(app, artworkUrl({ ...ref, revision: "0".repeat(64) })).then(
      (bytes) => (bytes === null ? "cancelled" : "leaked"),
      () => "cancelled",
    );
    await captured.promise;
    await page.evaluate((id) => window.lumen.accounts.activate(id), b);
    hold = false;
    held.release();
    expect(await pending).toBe("cancelled");
    const sizes = () =>
      app.evaluate(
        async ({ session }, ids) =>
          Promise.all(
            ids.map((id) =>
              session.fromPartition(`persist:artwork-${encodeURIComponent(id)}`).getCacheSize(),
            ),
          ),
        [a, b],
      );
    for (const size of await sizes()) expect(size).toBeGreaterThan(0);
    await page.evaluate((id) => window.lumen.accounts.remove(id), a);
    await expect.poll(async () => (await sizes())[0]).toBe(0);
    expect((await sizes())[1]).toBeGreaterThan(0);
    const beforeRetained = tokens.length;
    expect(await loadArtwork(app, artworkUrl(ref))).toBe(image);
    expect(tokens).toHaveLength(beforeRetained);
  } finally {
    held.release();
    await proxy.close();
  }
});

test("native artwork loads scaled through the app protocol, persists by account and revision, rejects arbitrary URLs and refetches changed files", async ({
  server,
  admin,
  desktop,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film/Film.mp4"], {
    "Film/poster.png": "still.png",
  });
  const poster = join(library.path, "Film/poster.png");
  const item = (await server.items(token, library.id))[0];
  const artwork = async () => {
    const { item: details } = await server.api<{
      item: { artworkId: string; artworkRevision: string };
    }>(`/items/${item?.id}`, { token });
    return { id: details.artworkId, revision: details.artworkRevision };
  };
  const proxy = await new NetworkProxy(server.origin).start();
  const reads = () => proxy.requests.filter((request) => request.path.includes("/artwork/")).length;
  try {
    await connectDesktop(desktop.page, proxy);
    // The library's poster loads in the page itself, as plain bytes from the app's own scheme.
    const card = desktop.page.locator(".library-tile img");
    await expect(card).toHaveAttribute("src", /^lumen-artwork:\/\/artwork\//);
    await expect
      .poll(() => card.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))
      .toBeGreaterThan(0);
    const ref = await artwork();
    const image = await loadArtwork(desktop.app, artworkUrl(ref));
    // The fixture is 480 pixels wide. A server that scales artwork answers at the step the URL
    // names; a released one without that capability still answers with the whole image.
    const { capabilities } = await server.api<{ capabilities?: Record<string, boolean> }>(
      "/server",
    );
    expect(Buffer.from(image ?? "", "base64").readUInt32BE(16)).toBe(
      capabilities?.artworkWidths === true ? 320 : 480,
    );
    const before = reads();
    expect(await loadArtwork(desktop.app, artworkUrl(ref))).toBe(image);
    expect(reads()).toBe(before);
    await desktop.app.close();
    const reopened = await launchDesktop(desktop.profile);
    try {
      const page = await mainDesktopPage(reopened);
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      expect(await loadArtwork(reopened, artworkUrl(ref))).toBe(image);
      expect(reads()).toBe(before);
      // Change the PNG contents at the same path, preserving a valid image signature.
      const original = await readFile(poster);
      await writeFile(poster, Buffer.concat([original, Buffer.from("revision-two")]));
      await server.scan(token, library.id, "full");
      const next = await artwork();
      expect(next.revision).not.toBe(ref.revision);
      const changed = await loadArtwork(reopened, artworkUrl(next));
      expect(changed).not.toBeNull();
      expect(reads()).toBeGreaterThan(before);
      const afterChange = reads();
      for (const url of [
        artworkUrl({ id: "https%3A%2F%2Fexample.invalid", revision: null }),
        artworkUrl(next, 500),
        `lumen-artwork://elsewhere/${next.id}?width=320`,
      ])
        expect(await loadArtwork(reopened, url)).toBeNull();
      expect(reads()).toBe(afterChange);
      const connection =
        (await page.evaluate(() => window.lumen.accounts.list())).activeConnectionId ?? "";
      await page.evaluate((id) => window.lumen.accounts.remove(id), connection);
      expect(await loadArtwork(reopened, artworkUrl(next))).toBeNull();
    } finally {
      await reopened.close();
    }
  } finally {
    await proxy.close();
  }
});
