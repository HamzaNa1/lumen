import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { latch, NetworkProxy } from "./support/proxy";
import { expect, password, test } from "./support/server";

test("real clients expose retry timing without resending mutations, reject incompatible discovery and discard retired session responses", async ({
  server,
  admin,
}) => {
  const proxy = await new NetworkProxy(server.origin).start();
  const client = new ServerClient({ origin: proxy.origin });
  try {
    await expect(client.me()).rejects.toMatchObject({ name: "AuthenticationRequiredError" });
    const input = { username: "admin", password };
    for (const [header, expected] of [
      ["42", 42],
      ["1", 1],
      ["0", 0],
      ["invalid", null],
      ["1.5", null],
      ["-1", null],
      ["99999999999999999999", null],
      ["Mon, 05 Oct 2020 12:00:00 GMT", 0],
      ["Monday, 05-Oct-20 12:00:00 GMT", 0],
      ["Mon Oct  5 12:00:00 2020", 0],
    ] as const) {
      const before = proxy.requests.length;
      proxy.intercept = async (_request, response) => {
        response
          .writeHead(429, { "retry-after": header, "content-type": "application/json" })
          .end('{"message":"Busy"}');
        return true;
      };
      await expect(client.login(input, crypto.randomUUID())).rejects.toMatchObject({
        status: 429,
        retryAfterSeconds: expected,
      });
      expect(proxy.requests.length - before).toBe(1);
    }
    proxy.intercept = async (_request, response) => {
      response.writeHead(429, { "retry-after": "3" }).end("limited");
      return true;
    };
    await expect(client.login(input, crypto.randomUUID())).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 3,
    });
    for (const apiVersion of ["1.4.2", "2.0.0", "1.01.0"]) {
      proxy.intercept = async (_request, response) => {
        const identity = await (await server.request("/api/v1/server")).json();
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ...identity, apiVersion }));
        return true;
      };
      if (apiVersion === "1.4.2") expect(await client.identity()).toMatchObject({ apiVersion });
      else
        await expect(client.identity()).rejects.toMatchObject({ name: "IncompatibleServerError" });
    }
    proxy.intercept = async () => false;
    await client.identity();
    await client.login(input, crypto.randomUUID());
    const blocked = latch();
    let requested = false;
    proxy.intercept = async (request) => {
      if (request.url?.includes("/libraries")) {
        requested = true;
        await blocked.promise;
      }
      return false;
    };
    const old = client.libraries().catch((error) => error);
    await expect.poll(() => requested).toBe(true);
    client.setSession(null);
    blocked.release();
    expect(await old).toMatchObject({ name: "RequestCancelledError" });
    proxy.intercept = async () => false;
    await client.login(input, crypto.randomUUID());
    const before = proxy.requests.length;
    proxy.intercept = async (request, response) => {
      if (request.method === "POST") {
        response.destroy();
        return true;
      }
      return false;
    };
    await expect(
      client.createLibrary({
        id: crypto.randomUUID(),
        name: "No retry",
        slug: "no-retry",
        kind: "movies",
      }),
    ).rejects.toMatchObject({ name: "ServerUnreachableError" });
    expect(proxy.requests.length - before).toBe(1);
    expect(await server.api("/libraries", { token: admin.accessToken })).toEqual([]);
  } finally {
    client.setSession(null);
    await proxy.close();
  }
});

test("desktop API client manages the catalog, scans, accounts and preferences through real authenticated HTTP", async ({
  server,
  admin,
}) => {
  const client = new ServerClient({ origin: server.origin });
  await client.identity();
  await client.login({ username: "admin", password }, crypto.randomUUID());
  expect(await client.renameServer("Living room")).toBe("Living room");
  expect(await client.identity()).toMatchObject({ displayName: "Living room" });
  expect(await client.updateMetadataSettings(null)).toEqual({ tmdbConfigured: false });
  const user = await client.createUser({ username: "viewer", displayName: "Viewer", password });
  expect(
    await client.updateUser(user.id, {
      displayName: "Renamed",
      libraryAccess: { scope: "selected", libraryIds: [] },
    }),
  ).toMatchObject({ displayName: "Renamed" });
  expect(await client.users()).toHaveLength(2);
  const library = await client.createLibrary({
    id: crypto.randomUUID(),
    name: "Films",
    slug: "films",
    kind: "movies",
  });
  const path = `${server.root}/client-library`;
  await server.media(path, "Film.mp4");
  const root = (await client.addLibraryRoot({
    id: crypto.randomUUID(),
    libraryId: library.id,
    path,
    priority: 1,
  })) as { id: string };
  expect(await client.libraryRoots(library.id)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: root.id })]),
  );
  expect(await client.updateLibrary(library.id, { name: "Movies" })).toMatchObject({
    name: "Movies",
  });
  const scan = await client.startScan(library.id, "full");
  await expect.poll(async () => (await client.scanStatus(scan.runId)).status).toBe("succeeded");
  const item = (await client.items(library.id)).items[0];
  if (!item) throw new Error("Missing scanned movie");
  expect(await client.search("Film", library.id)).toEqual(
    expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({ id: item.id })]),
    }),
  );
  await client.setWatched(item.id, true);
  expect(await client.itemDetails(item.id)).toMatchObject({ watchState: { completed: true } });
  expect(await client.updateTrackPreferences({ subtitleLanguage: null })).toMatchObject({
    subtitleLanguage: null,
  });
  expect(await client.jobLog()).not.toHaveLength(0);
  await expect(client.matchOptions(item.id, "Film")).rejects.toMatchObject({ status: 400 });
  await expect(client.setMatch(item.id, { tmdbId: "42" })).rejects.toMatchObject({ status: 400 });
  await expect(client.episodeOrder(item.id)).rejects.toMatchObject({ status: 400 });
  await expect(
    client.setEpisodeOrder(item.id, { tmdbSeriesId: "42", groupId: null }),
  ).rejects.toMatchObject({ status: 400 });
  await client.deleteLibraryRoot(root.id);
  expect((await client.items(library.id)).items).toEqual([]);
  await client.deleteLibrary(library.id);
  expect(await client.adminLibraries()).toEqual([]);
  for (const origin of ["http://user:secret@localhost", `${server.origin}unexpected`])
    expect(() => new ServerClient({ origin })).toThrow();
  expect(await server.api("/users", { token: admin.accessToken })).toHaveLength(2);
});

test("first-run client registration and older discovery fail safely across real HTTP boundaries", async ({
  server,
}) => {
  const proxy = await new NetworkProxy(server.origin).start();
  const client = new ServerClient({ origin: proxy.origin });
  try {
    expect((await client.discover()).setupRequired).toBe(true);
    const registered = await client.register({ username: "admin", password }, crypto.randomUUID());
    expect(await client.me()).toMatchObject({ id: registered.userId, role: "admin" });
    await expect(client.migrateLegacySession("invalid-refresh-token")).rejects.toMatchObject({
      status: 400,
    });
    let status = 404;
    proxy.intercept = async (request, response) => {
      if (request.url?.includes("/auth/setup")) {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end('{"message":"Unavailable"}');
        return true;
      }
      if (request.url === "/api/v1/server") {
        const identity = await (await server.request("/api/v1/server")).json();
        delete identity.capabilities;
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(identity));
        return true;
      }
      return false;
    };
    expect((await client.discover()).setupRequired).toBe(false);
    expect(await client.setupRequired(true)).toBe(true);
    status = 503;
    await expect(client.setupRequired()).rejects.toMatchObject({ status: 503 });
    expect(await client.trackPreferences()).toBeNull();
    await expect(client.updateTrackPreferences({ audioLanguage: "en" })).rejects.toThrow(
      "does not support",
    );
    expect(
      await client.saveTrackChoice(crypto.randomUUID(), { kind: "audio", choice: null }),
    ).toBeNull();
    expect(await client.adjacentEpisodes(crypto.randomUUID())).toEqual({
      previous: null,
      next: null,
    });
  } finally {
    client.setSession(null);
    await proxy.close();
  }
});
