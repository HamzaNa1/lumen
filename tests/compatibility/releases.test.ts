import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const serverRoot = process.env.LUMEN_COMPAT_SERVER_ROOT ?? root;
const desktopRoot = process.env.LUMEN_COMPAT_DESKTOP_ROOT ?? root;
const { startServer } = (await import(
  pathToFileURL(join(serverRoot, "apps/server/src/Runtime.ts")).href
)) as typeof import("../../apps/server/src/Runtime");
const { ServerClient } = (await import(
  pathToFileURL(join(desktopRoot, "apps/desktop/src/main/api/ServerClient.ts")).href
)) as typeof import("../../apps/desktop/src/main/api/ServerClient");

test("independently released apps can discover, authenticate, restore sessions, and browse libraries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "lumen-compatibility-data-"));
  const server = await startServer({
    dataDir,
    databasePath: join(dataDir, "server.sqlite"),
    host: "127.0.0.1",
    port: 0,
    maxRequestsPerMinute: 10_000,
    loginAttemptsPerMinute: 100,
  });
  try {
    const origin = server.server.url.origin;
    const client = new ServerClient({ origin });
    const discovery = await client.discover();
    expect(discovery.identity.apiVersion).toMatch(/^1\./);
    expect(discovery.setupRequired).toBe(true);
    const deviceId = crypto.randomUUID();
    const credentials = {
      origin,
      username: "owner",
      password: "compatibility test password",
     
    };
    const session = await client.register(credentials, deviceId);
    expect((await client.me()).role).toBe("admin");
    if (serverRoot === root) {
      const manifest = JSON.parse(
        await readFile(join(serverRoot, "apps/server/package.json"), "utf8"),
      );
      const info = (await (await fetch(new URL("/api/v1/server", origin))).json()) as {
        serverVersion: string;
      };
      expect(info.serverVersion).toBe(manifest.version);
      const diagnostics = await client.request<{ version: string }>("/diagnostics");
      expect(diagnostics.version).toBe(manifest.version);
    }
    expect((await client.discover()).setupRequired).toBe(false);
    const id = crypto.randomUUID();
    await client.createLibrary({ id, name: "Movies", slug: "movies", kind: "movies" });
    expect((await client.libraries()).map((entry) => entry.id)).toEqual([id]);
    expect((await client.items(id, null)).items).toEqual([]);
    await client.home();

    const restored = new ServerClient({ origin });
    expect((await restored.identity()).serverId).toBe(discovery.identity.serverId);
    restored.setSession(session);
    expect((await restored.me()).id).toBe(session.userId);
    expect((await restored.libraries()).map((entry) => entry.id)).toEqual([id]);
    const signedIn = new ServerClient({ origin });
    await signedIn.login(credentials, deviceId);
    expect((await signedIn.me()).id).toBe(session.userId);
    await signedIn.deleteLibrary(id);
    expect(await signedIn.libraries()).toEqual([]);
  } finally {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);
