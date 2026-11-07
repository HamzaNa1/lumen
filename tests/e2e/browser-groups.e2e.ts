import { playing, signIn } from "./support/browser";
import { expect, test } from "./support/watch";

test("two browser players hold for a slow member, recover drift, replace media and stop together", async ({
  server,
  admin,
  page,
  context,
  connect,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4", "Other.mp4"]);
  const items = await server.items(admin.accessToken, library.id);
  const owner = await connect(admin.accessToken);
  await owner.action({ type: "create", name: "Together", password: "" });
  await signIn(page, server);
  const second = await context.newPage();
  await second.goto(`${server.origin}web/`);
  for (const member of [page, second]) {
    await member.locator(".watch-group-trigger").click();
    await member.getByRole("button", { name: /Together.*Join/ }).click();
    await expect(member.locator(".watch-group-trigger.is-active")).toBeVisible();
    await member.keyboard.press("Escape");
  }
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
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator("video")).toBeAttached();
    await expect.poll(() => owner.status.group?.playback?.waitingFor?.length).toBeGreaterThan(0);
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(true);
    await owner.action({ type: "pause", itemId: film, paused: true, positionSeconds: 3 });
    release.resolve();
    for (const member of [page, second])
      await expect(member.getByRole("region", { name: "Media player" })).toHaveAttribute(
        "data-status",
        /ready|blocked/,
      );
    await owner.action({ type: "pause", itemId: film, paused: false, positionSeconds: 3 });
    for (const member of [page, second]) await playing(member);
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
      })
      .toBeLessThan(1.5);
    await owner.action({ type: "play", itemId: other, positionSeconds: 0, replaces: film });
    for (const member of [page, second]) {
      await expect(member.getByRole("region", { name: "Media player" })).toContainText("Other");
      await playing(member);
    }
    await owner.action({ type: "stop", itemId: other });
    for (const member of [page, second]) await expect(member.locator("video")).toHaveCount(0);
    expect(owner.status.group?.playback).toBeNull();
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
