import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectDesktop, expect, launchDesktop, mainDesktopPage, test } from "./support/desktop";
import { latch, NetworkProxy } from "./support/proxy";
import { password } from "./support/server";

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
    const image = await page.evaluate((ref) => window.lumen.library.artwork(ref), ref);
    expect(image).toMatch(/^data:image\/png;base64,/);
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
    expect(await page.evaluate((ref) => window.lumen.library.artwork(ref), ref)).toBe(image);
    expect(tokens.length).toBeGreaterThan(beforeB);
    expect(tokens.at(-1)).not.toBe(tokenA);
    await page.evaluate((id) => window.lumen.accounts.activate(id), a);
    const beforeA = tokens.length;
    expect(await page.evaluate((ref) => window.lumen.library.artwork(ref), ref)).toBe(image);
    expect(tokens).toHaveLength(beforeA);
    hold = true;
    const pending = page.evaluate(
      (ref) =>
        window.lumen.library.artwork(ref).then(
          () => "leaked",
          () => "cancelled",
        ),
      { ...ref, revision: "0".repeat(64) },
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
    expect(await page.evaluate((ref) => window.lumen.library.artwork(ref), ref)).toBe(image);
    expect(tokens).toHaveLength(beforeRetained);
  } finally {
    held.release();
    await proxy.close();
  }
});

test("native artwork cache persists by account and revision, rejects arbitrary URLs and refetches changed files", async ({
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
    const ref = await artwork();
    const url = await desktop.page.evaluate((ref) => window.lumen.library.artwork(ref), ref);
    expect(url).toMatch(/^data:image\/png;base64,/);
    const before = reads();
    expect(await desktop.page.evaluate((ref) => window.lumen.library.artwork(ref), ref)).toBe(url);
    expect(reads()).toBe(before);
    await desktop.app.close();
    const reopened = await launchDesktop(desktop.profile);
    try {
      const page = await mainDesktopPage(reopened);
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      expect(await page.evaluate((ref) => window.lumen.library.artwork(ref), ref)).toBe(url);
      expect(reads()).toBe(before);
      // Change the PNG contents at the same path, preserving a valid image signature.
      const original = Buffer.from(url?.split(",")[1] ?? "", "base64");
      await writeFile(poster, Buffer.concat([original, Buffer.from("revision-two")]));
      await server.scan(token, library.id, "full");
      const next = await artwork();
      expect(next.revision).not.toBe(ref.revision);
      const changed = await page.evaluate((ref) => window.lumen.library.artwork(ref), next);
      expect(changed).not.toBe(url);
      expect(reads()).toBeGreaterThan(before);
      await expect(
        page.evaluate(() =>
          window.lumen.library.artwork({ id: "https://example.invalid", revision: null }),
        ),
      ).rejects.toThrow();
      const connection =
        (await page.evaluate(() => window.lumen.accounts.list())).activeConnectionId ?? "";
      await page.evaluate((id) => window.lumen.accounts.remove(id), connection);
      await expect(
        page.evaluate((ref) => window.lumen.library.artwork(ref), next),
      ).rejects.toThrow();
    } finally {
      await reopened.close();
    }
  } finally {
    await proxy.close();
  }
});
