import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectDesktop, expect, launchDesktop, test } from "./support/desktop";
import { NetworkProxy } from "./support/proxy";
import { repository } from "./support/server";

test("native artwork cache persists by account and revision, rejects arbitrary URLs and refetches changed files", async ({
  server,
  admin,
  desktop,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film/Film.mp4"]);
  const poster = join(library.path, "Film/poster.png");
  await copyFile(join(repository, "tests/fixtures/still.png"), poster);
  await server.scan(token, library.id, "full");
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
      const page = await reopened.firstWindow();
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
