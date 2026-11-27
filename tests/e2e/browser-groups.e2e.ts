import { often, openPlaybackInfo, playbackInfoValue, playing, signIn } from "./support/browser";
import { expect, test } from "./support/watch";

test("two browser players hold for a slow member, recover drift, replace media and stop together", async ({
  server,
  admin,
  page,
  context,
  connect,
}) => {
  const second = await context.newPage();
  const [items, owner] = await Promise.all([
    server
      .library(admin.accessToken, "movies", ["Film.mp4", "Other.mp4"])
      .then((library) => server.items(admin.accessToken, library.id)),
    connect(admin.accessToken).then(async (owner) => {
      await owner.action({ type: "create", name: "Together", password: "" });
      return owner;
    }),
    signIn(page, server).then(() => second.goto(`${server.origin}web/`)),
  ]);
  await Promise.all(
    [page, second].map(async (member) => {
      await member.locator(".watch-group-trigger").click();
      await member.getByRole("button", { name: /Together.*Join/ }).click();
      await expect(member.locator(".watch-group-trigger.is-active")).toBeVisible();
      await member.keyboard.press("Escape");
    }),
  );
  const release = Promise.withResolvers<void>();
  let requested = false;
  await second.route("**/api/v1/media/**", async (route) => {
    requested = true;
    await release.promise;
    await route.continue().catch(() => {});
  });
  const film = items.find((item) => item.title === "Film")?.id ?? "";
  const other = items.find((item) => item.title === "Other")?.id ?? "";
  try {
    await owner.action({ type: "play", itemId: film, positionSeconds: 2 });
    await expect.poll(() => requested, often).toBe(true);
    await expect(page.locator("video")).toBeAttached();
    await expect
      .poll(() => owner.status.group?.playback?.waitingFor?.length, often)
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused), often)
      .toBe(true);
    const held = await openPlaybackInfo(page);
    await expect(playbackInfoValue(held, "Group")).toHaveText(/^Holding for /u);
    await expect(playbackInfoValue(held, "Connection")).toHaveText("Connected");
    await held.getByRole("button", { name: "Close playback info" }).click();
    await owner.action({ type: "pause", itemId: film, paused: true, positionSeconds: 3 });
    release.resolve();
    for (const member of [page, second])
      await expect(member.getByRole("region", { name: "Media player" })).toHaveAttribute(
        "data-status",
        /ready|blocked/,
      );
    await owner.action({ type: "pause", itemId: film, paused: false, positionSeconds: 3 });
    await Promise.all([page, second].map(playing));
    // Move the real decoder ahead without a shared seek; the controller must correct its clock.
    await second.locator("video").evaluate((video: HTMLVideoElement) => {
      video.currentTime += 3;
    });
    await expect
      .poll(async () => {
        const positions = await Promise.all(
          [page, second].map((member) =>
            member.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime),
          ),
        );
        return Math.abs((positions[0] ?? 0) - (positions[1] ?? 0));
      }, often)
      .toBeLessThan(1.5);
    const sync = await openPlaybackInfo(second);
    await expect(playbackInfoValue(sync, "Group")).toHaveText("Playing");
    // Three seconds is too far to ease back from, so the player seeked to the group.
    await expect(playbackInfoValue(sync, "Catch-up seeks")).toHaveText(/^[1-9]\d*$/u);
    await expect(playbackInfoValue(sync, "Drift")).toHaveText(/^\d+ ms( behind| ahead)?$/u);
    await expect(playbackInfoValue(sync, "Round trip")).toHaveText(/^\d+ ms \(best \d+ ms\)$/u);
    await expect(playbackInfoValue(sync, "Clock offset")).toHaveText(/^[+-]?\d+ ms$/u);
    await sync.getByRole("button", { name: "Close playback info" }).click();
    await owner.action({ type: "play", itemId: other, positionSeconds: 0, replaces: film });
    await Promise.all(
      [page, second].map(async (member) => {
        await expect(member.getByRole("region", { name: "Media player" })).toContainText("Other");
        await playing(member);
      }),
    );
    // A member who leaves keeps watching what the group played, still named by it.
    await second.getByRole("button", { name: "Together, 3 people" }).click();
    await second.getByRole("button", { name: "Leave" }).click();
    await expect.poll(() => owner.status.group?.members.length, often).toBe(2);
    await second.keyboard.press("Escape");
    await expect(
      second.locator(".media-player-header").getByRole("heading", { name: "Other", exact: true }),
    ).toBeVisible();
    await playing(second);
    await owner.action({ type: "stop", itemId: other });
    await expect(page.locator("video")).toHaveCount(0);
    expect(owner.status.group?.playback).toBeNull();
    await playing(second);
  } finally {
    release.resolve();
    await second.close();
  }
});

test("a movie started in a watch group keeps the description it started with as the group takes it over", async ({
  server,
  admin,
  page,
  connect,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const film = (await server.items(admin.accessToken, library.id))[0]?.id;
  const owner = await connect(admin.accessToken);
  await owner.action({ type: "create", name: "Together", password: "" });
  await signIn(page, server);
  await page.locator(".watch-group-trigger").click();
  await page.getByRole("button", { name: /Together.*Join/ }).click();
  await expect(page.locator(".watch-group-trigger.is-active")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => owner.status.group?.members.length).toBe(2);
  const lookups: string[] = [];
  await page.route(
    (url) =>
      /\/api\/v1\/items\/[^/]+$/.test(url.pathname) || url.pathname.endsWith("/adjacent-episodes"),
    (route) => {
      lookups.push(route.request().url());
      return route.abort();
    },
  );
  // Loading a page anew would leave the group, so the library is reached from within the app.
  await page.getByRole("link", { name: "movies", exact: true }).click();
  await page.getByRole("button", { name: "Play Film", exact: true }).first().click({ force: true });
  await expect.poll(() => owner.status.group?.playback?.itemId).toBe(film);
  await playing(page);
  await expect(
    page.locator(".media-player-header").getByRole("heading", { name: "Film", exact: true }),
  ).toBeVisible();
  expect(lookups).toEqual([]);
});
