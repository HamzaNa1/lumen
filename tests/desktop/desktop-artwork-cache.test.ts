import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AccountSummary, ArtworkRef } from "@lumen/contracts";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import {
  ArtworkCache,
  type ArtworkSession,
  artworkPartition,
} from "../../apps/desktop/src/main/artwork/ArtworkCache";
import { electronTestExports, ipcHandlers } from "../helpers/electron";

mock.module("electron", () => electronTestExports);
const { registerIpcHandlers, unregisterIpcHandlers } = await import(
  "../../apps/desktop/src/main/ipc/registerHandlers"
);

const origin = "http://artwork.test";
const serverId = crypto.randomUUID();
const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const dataUrl = (bytes: Uint8Array): string =>
  `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

interface ServerRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly credentials: RequestCredentials | undefined;
  readonly signal: AbortSignal | null | undefined;
}

/** The server's side of artwork: what each ID currently holds, answered as the real one would. */
const artworkServer = () => {
  const images = new Map<string, Uint8Array>();
  const requests: ServerRequest[] = [];
  let answer: (request: ServerRequest) => Promise<Response> | Response = (request) => {
    const url = new URL(request.url);
    const bytes = images.get(url.pathname.split("/").at(-1) ?? "");
    if (bytes === undefined) return Response.json({ message: "Artwork not found" }, { status: 404 });
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control":
          url.searchParams.get("revision") === sha256(bytes)
            ? "private, max-age=31536000, immutable"
            : "private, max-age=0, must-revalidate",
      },
    });
  };
  return {
    images,
    requests,
    answerWith: (next: typeof answer) => {
      answer = next;
    },
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const request = {
        url: input,
        authorization: new Headers(init?.headers).get("authorization"),
        credentials: init?.credentials,
        signal: init?.signal,
      };
      requests.push(request);
      return answer(request);
    },
  };
};

/**
 * Stands in for Chromium's sessions: one HTTP cache per partition, keyed by URL, that outlives the
 * objects using it and reuses only what the server declared immutable.
 */
const chromiumDisk = (server: ReturnType<typeof artworkServer>) => {
  const partitions = new Map<string, Map<string, Uint8Array>>();
  const failingClears = new Set<string>();
  const open = (partition: string): ArtworkSession => {
    const stored = partitions.get(partition) ?? new Map<string, Uint8Array>();
    partitions.set(partition, stored);
    return {
      fetch: async (input, init) => {
        const hit = stored.get(input);
        if (hit !== undefined)
          return new Response(hit, { headers: { "content-type": "image/png" } });
        const response = await server.fetch(input, init);
        if (response.ok && response.headers.get("cache-control")?.includes("immutable"))
          stored.set(input, new Uint8Array(await response.clone().arrayBuffer()));
        return response;
      },
      clearCache: async () => {
        if (failingClears.has(partition)) throw new Error("disk is busy");
        stored.clear();
      },
    };
  };
  return { partitions, failingClears, open };
};

const account = (username: string): AccountSummary => ({
  connectionId: crypto.randomUUID(),
  serverId,
  origin,
  username,
  serverName: "Test",
  userId: crypto.randomUUID(),
  role: "user",
  secureStorageAvailable: true,
  lastConnectedAtMs: null,
});

const tokens = new Map<string, string>();
const signedIn = (value: AccountSummary): ServerClient => {
  const sessionId = crypto.randomUUID();
  const accessToken = `${sessionId}.${"x".repeat(43)}`;
  tokens.set(value.connectionId, accessToken);
  const client = new ServerClient({
    origin,
    // Only what does not go through the artwork cache should arrive here.
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/server")
        return Response.json({ serverId, displayName: "Test", apiVersion: "1.0.0" });
      if (path === "/api/v1/auth/me")
        return Response.json({
          id: value.userId,
          username: value.username,
          displayName: value.username,
          role: "user",
          isActive: true,
          createdAtMs: 1,
          updatedAtMs: 1,
        });
      throw new Error(`Unexpected request ${path}`);
    },
  });
  client.setSession({
    userId: value.userId,
    role: "user",
    sessionId,
    accessToken,
    accessExpiresAtMs: Date.now() + 60_000,
  });
  return client;
};

/** One run of the app's main process over a disk that may hold an earlier run's cache. */
const launch = (
  disk: ReturnType<typeof chromiumDisk>,
  saved: ReadonlyArray<AccountSummary>,
  active: AccountSummary,
) => {
  const accounts = new Map(saved.map((value) => [value.connectionId, value]));
  let activeId: string | null = active.connectionId;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { send: () => undefined },
  });
  registerIpcHandlers({
    registry: {
      active: () => accounts.get(activeId ?? "") ?? null,
      find: (id: string) => accounts.get(id) ?? null,
      list: async () => ({ accounts: [...accounts.values()], activeConnectionId: activeId }),
      activate: async (id: string) => {
        activeId = id;
      },
      remove: async (id: string) => {
        accounts.delete(id);
        if (activeId === id) activeId = null;
      },
    },
    clients: new Map(saved.map((value) => [value.connectionId, signedIn(value)])),
    artwork: new ArtworkCache(disk.open),
    installationId: crypto.randomUUID(),
    window,
    overlay: { window },
    player: { getState: () => null, stop: async () => undefined },
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  const invoke = (name: string, ...args: unknown[]): Promise<unknown> => {
    const handler = ipcHandlers.get(name);
    if (handler === undefined) throw new Error(`Missing handler ${name}`);
    return handler({ senderFrame: { url: "file:///renderer/index.html" } }, ...args);
  };
  return {
    invoke,
    artwork: (artwork: ArtworkRef) => invoke("library:artwork", artwork),
    quit: () => {
      window.emit("closed");
      unregisterIpcHandlers();
    },
  };
};

let running: ReturnType<typeof launch> | null = null;
const start = (...args: Parameters<typeof launch>) => {
  running?.quit();
  running = launch(...args);
  return running;
};
afterEach(() => {
  running?.quit();
  running = null;
});

const poster = new Uint8Array([1, 2, 3, 4]);
const replacement = new Uint8Array([9, 8, 7]);

test("artwork loaded once is shown after a restart without asking the server again", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const viewer = account("viewer");
  const artwork = { id: crypto.randomUUID(), revision: sha256(poster) };
  server.images.set(artwork.id, poster);

  expect(await start(disk, [viewer], viewer).artwork(artwork)).toBe(dataUrl(poster));
  expect(server.requests).toEqual([
    {
      url: `${origin}/api/v1/artwork/${artwork.id}?revision=${artwork.revision}`,
      authorization: `Bearer ${tokens.get(viewer.connectionId)}`,
      credentials: "omit",
      signal: expect.any(AbortSignal),
    },
  ]);

  // A new process, new clients and a new cache object; only the disk carries over.
  const restarted = start(disk, [viewer], viewer);
  expect(await restarted.artwork(artwork)).toBe(dataUrl(poster));
  expect(await restarted.artwork(artwork)).toBe(dataUrl(poster));
  expect(server.requests).toHaveLength(1);
});

test("an image replaced under the same artwork ID is fetched again under its new revision", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const viewer = account("viewer");
  const id = crypto.randomUUID();
  server.images.set(id, poster);
  const app = start(disk, [viewer], viewer);
  await app.artwork({ id, revision: sha256(poster) });

  server.images.set(id, replacement);
  expect(await app.artwork({ id, revision: sha256(replacement) })).toBe(dataUrl(replacement));
  expect(await app.artwork({ id, revision: sha256(replacement) })).toBe(dataUrl(replacement));
  expect(server.requests.map((request) => new URL(request.url).searchParams.get("revision"))).toEqual(
    [sha256(poster), sha256(replacement)],
  );
});

test("artwork the server did not vouch for is asked for on every use", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const viewer = account("viewer");
  const id = crypto.randomUUID();
  server.images.set(id, replacement);
  const app = start(disk, [viewer], viewer);

  // A server from before revisions names none; a stale revision no longer matches the file.
  for (const artwork of [
    { id, revision: null },
    { id, revision: sha256(poster) },
  ]) {
    expect(await app.artwork(artwork)).toBe(dataUrl(replacement));
    expect(await app.artwork(artwork)).toBe(dataUrl(replacement));
  }
  expect(server.requests).toHaveLength(4);
  expect(new URL(server.requests[0]?.url ?? "").search).toBe("");
});

test("each account keeps its own artwork and sends its own token", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const first = account("first");
  const second = account("second");
  const artwork = { id: crypto.randomUUID(), revision: sha256(poster) };
  server.images.set(artwork.id, poster);
  const app = start(disk, [first, second], first);
  await app.artwork(artwork);

  // The second account may not see this library: the first account's copy must not answer for it.
  server.answerWith(() => Response.json({ message: "Forbidden" }, { status: 403 }));
  await app.invoke("accounts:activate", second.connectionId);
  expect(await app.artwork(artwork)).toBeNull();
  expect(server.requests.map((request) => request.authorization)).toEqual([
    `Bearer ${tokens.get(first.connectionId)}`,
    `Bearer ${tokens.get(second.connectionId)}`,
  ]);
  expect(disk.partitions.get(artworkPartition(second.connectionId))?.size).toBe(0);

  await app.invoke("accounts:activate", first.connectionId);
  expect(await app.artwork(artwork)).toBe(dataUrl(poster));
  expect(server.requests).toHaveLength(2);
});

test("artwork still loading when the account changes never reaches the next account", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const first = account("first");
  const second = account("second");
  const artwork = { id: crypto.randomUUID(), revision: sha256(poster) };
  const late = Promise.withResolvers<Response>();
  // Ignore abort here: the client must reject even a transport that answers late.
  server.answerWith(() => late.promise);
  const app = start(disk, [first, second], first);
  const pending = app.artwork(artwork).catch((cause: unknown) => cause);
  await Bun.sleep(0);

  await app.invoke("accounts:activate", second.connectionId);
  expect(server.requests[0]?.signal?.aborted).toBe(true);
  late.resolve(new Response(poster, { headers: { "content-type": "image/png" } }));
  expect(await pending).toHaveProperty("name", "RequestCancelledError");
});

test("removing an account empties its artwork and leaves the others'", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const first = account("first");
  const second = account("second");
  const artwork = { id: crypto.randomUUID(), revision: sha256(poster) };
  server.images.set(artwork.id, poster);
  const app = start(disk, [first, second], first);
  await app.artwork(artwork);
  await app.invoke("accounts:activate", second.connectionId);
  await app.artwork(artwork);

  await app.invoke("accounts:remove", second.connectionId);
  expect(disk.partitions.get(artworkPartition(second.connectionId))?.size).toBe(0);
  expect(disk.partitions.get(artworkPartition(first.connectionId))?.size).toBe(1);
});

test("an account is still removed when its artwork cannot be cleared", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const viewer = account("viewer");
  disk.failingClears.add(artworkPartition(viewer.connectionId));
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const app = start(disk, [viewer], viewer);
    expect(await app.invoke("accounts:remove", viewer.connectionId)).toEqual({
      accounts: [],
      activeConnectionId: null,
    });
    expect(errors).toHaveLength(1);
  } finally {
    console.error = consoleError;
  }
});

test("unavailable, mistyped and unreachable artwork is reported without being kept", async () => {
  const server = artworkServer();
  const disk = chromiumDisk(server);
  const viewer = account("viewer");
  const artwork = { id: crypto.randomUUID(), revision: sha256(poster) };
  const app = start(disk, [viewer], viewer);

  expect(await app.artwork(artwork)).toBeNull();
  server.answerWith(
    () =>
      new Response("<html>", {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      }),
  );
  expect(await app.artwork(artwork)).toBeNull();
  server.answerWith(() => {
    throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
  });
  await expect(app.artwork(artwork)).rejects.toThrow("ERR_INTERNET_DISCONNECTED");

  // Once the image is there, nothing from the failures stands in its way.
  server.images.set(artwork.id, poster);
  server.answerWith((request) =>
    new Response(server.images.get(new URL(request.url).pathname.split("/").at(-1) ?? ""), {
      headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" },
    }),
  );
  expect(await app.artwork(artwork)).toBe(dataUrl(poster));
  expect(server.requests).toHaveLength(4);
});

test("the renderer cannot ask for anything but an artwork reference", async () => {
  const server = artworkServer();
  const viewer = account("viewer");
  const app = start(chromiumDisk(server), [viewer], viewer);
  for (const request of [
    "../../admin/users",
    { id: "../../admin/users", revision: null },
    { id: crypto.randomUUID(), revision: "../secret" },
  ])
    await expect(app.invoke("library:artwork", request)).rejects.toThrow();
  expect(server.requests).toHaveLength(0);
});

test("partitions are persistent and distinct per connection", () => {
  const first = crypto.randomUUID();
  expect(artworkPartition(first)).toBe(`persist:artwork-${first}`);
  expect(artworkPartition(crypto.randomUUID())).not.toBe(artworkPartition(first));
});
