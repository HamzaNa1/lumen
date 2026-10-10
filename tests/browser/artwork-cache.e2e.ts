import { expect, test } from "@playwright/test";

test("artwork caching respects logout and account changes", async ({
  page,
  browserName,
}) => {
  // Use the real browser cache and cookie jar without app queries racing the account changes.
  await page.goto("/health/live");
  const results = await page.evaluate(async () => {
    const password = "correct horse battery staple";
    const mutate = (path: string, body?: unknown) =>
      fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lumen-csrf": "1" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const login = (username: string) =>
      mutate("/api/v1/auth/browser/login", {
        username,
        password,
        deviceId: crypto.randomUUID(),
        deviceName: "Artwork cache test",
      });
    const adminLogin = (await login("admin")).status;
    const username = `artwork-${crypto.randomUUID()}`;
    const created = await mutate("/api/v1/users", {
      username,
      displayName: "No library access",
      password,
      role: "user",
      libraryAccess: { scope: "selected", libraryIds: [] },
    });
    const libraries = await (await fetch("/api/v1/libraries")).json();
    const items = await (await fetch(`/api/v1/items?libraryId=${libraries[0].id}`)).json();
    const show = items.items.find((item: { title: string }) => item.title === "Serial");
    const seasons = await (await fetch(`/api/v1/items/${show.id}/children`)).json();
    const episodes = await (await fetch(`/api/v1/items/${seasons.items[0].id}/children`)).json();
    const episode = episodes.items[0];
    const url = `/api/v1/artwork/${episode.artworkId}?revision=${episode.artworkRevision}`;
    const image = async () => {
      const response = await fetch(url);
      await response.arrayBuffer();
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        requestId: response.headers.get("x-request-id"),
      };
    };
    const first = await image();
    const cached = await image();
    const logout = (await mutate("/api/v1/auth/browser/logout")).status;
    const signedOut = await image();
    const viewerLogin = (await login(username)).status;
    const otherAccount = await image();
    return {
      adminLogin,
      created: created.status,
      first,
      cached,
      logout,
      signedOut,
      viewerLogin,
      otherAccount,
    };
  });
  expect(results.adminLogin).toBe(200);
  expect(results.created).toBe(201);
  expect(results.first.status).toBe(200);
  expect(results.first.cacheControl).toContain("immutable");
  expect(results.cached.status).toBe(200);
  // Chromium powers the desktop cache. Other engines may decline to store this response.
  // The server generates a new ID for every request, so reusing it proves a cache hit.
  expect(results.first.requestId).toBeTruthy();
  if (browserName === "chromium") expect(results.cached.requestId).toBe(results.first.requestId);
  expect(results.logout).toBe(200);
  expect(results.signedOut.status).toBe(401);
  expect(results.viewerLogin).toBe(200);
  expect(results.otherAccount.status).toBe(403);
});
