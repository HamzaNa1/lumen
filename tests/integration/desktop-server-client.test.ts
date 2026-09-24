import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { deviceIdForAccount, getOrCreateInstallationId } from "../../apps/desktop/src/main/accounts/InstallationId";
import { ids } from "../../packages/testkit/src/ids";

describe("desktop installation identity", () => {
  test("persists one installation ID across loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "lumen-installation-id-"));
    const path = join(root, "installation.json");

    try {
      const first = await getOrCreateInstallationId(path);
      const second = await getOrCreateInstallationId(path);

      expect(second).toBe(first);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ id: first });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses a stable device ID for each server account", () => {
    const first = deviceIdForAccount(ids.device, ids.library, "Admin");
    expect(deviceIdForAccount(ids.device, ids.library, " admin ")).toBe(first);
    expect(deviceIdForAccount(ids.device, ids.library, "viewer")).not.toBe(first);
    expect(deviceIdForAccount(ids.device, ids.user, "admin")).not.toBe(first);
  });
});

describe("ServerClient discovery", () => {
  test("restores an expired session and persists rotated credentials before requesting data", async () => {
    const calls: string[] = [];
    const client = new ServerClient({
      origin: "https://media.example",
      onSessionChanged: async (session) => { calls.push(`saved ${session.refreshToken}`); },
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/v1/auth/refresh") {
          calls.push("refresh");
          return new Response(JSON.stringify({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "new-access", refreshToken: "new-refresh", accessExpiresAtMs: Date.now() + 900_000, refreshExpiresAtMs: Date.now() + 2_592_000_000 }), { status: 200 });
        }
        calls.push(`request ${new Headers(init?.headers).get("authorization")}`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "old-access", refreshToken: "old-refresh", accessExpiresAtMs: 1, refreshExpiresAtMs: Date.now() + 100_000 });
    expect(await client.request("/api/v1/test")).toEqual({ ok: true });
    expect(calls).toEqual(["refresh", "saved new-refresh", "request Bearer new-access"]);
  });

  test("shares one refresh across simultaneous requests", async () => {
    let refreshes = 0;
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (input, init) => {
        if (new URL(String(input)).pathname === "/api/v1/auth/refresh") {
          refreshes += 1;
          await Promise.resolve();
          return new Response(JSON.stringify({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "new-access", refreshToken: "new-refresh", accessExpiresAtMs: Date.now() + 900_000, refreshExpiresAtMs: Date.now() + 2_592_000_000 }), { status: 200 });
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new-access");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "old-access", refreshToken: "old-refresh", accessExpiresAtMs: 1, refreshExpiresAtMs: Date.now() + 100_000 });
    await Promise.all([client.request("/api/v1/one"), client.request("/api/v1/two")]);
    expect(refreshes).toBe(1);
  });

  test("discovers a server and its setup status before authentication", async () => {
    const requests: Array<string> = [];
    const client = new ServerClient({
      origin: "http://localhost:3210/",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ serverId: "server-1", displayName: "Lumen", apiVersion: "1.0.0", setupRequired: true }), { status: 200 });
      },
    });

    const result = await client.discover();

    expect(result.origin).toBe("http://localhost:3210");
    expect(result.identity.serverId).toBe("server-1");
    expect(result.setupRequired).toBe(true);
    expect(requests).toEqual(["http://localhost:3210/api/v1/server", "http://localhost:3210/api/v1/auth/setup"]);
  });

  test("falls back to the setup endpoint when the server identity omits setup status", async () => {
    const requests: Array<string> = [];
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/api/v1/server")) return new Response(JSON.stringify({ serverId: "server-2", displayName: "Lumen", apiVersion: "1.0.0" }), { status: 200 });
        return new Response(JSON.stringify({ setupRequired: false }), { status: 200 });
      },
    });

    const result = await client.discover();

    expect(result.setupRequired).toBe(false);
    expect(requests).toEqual(["https://media.example/api/v1/server", "https://media.example/api/v1/auth/setup"]);
  });

  test("uses the current setup endpoint when the identity response is stale", async () => {
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (input, init) => {
        expect(init?.cache).toBe("no-store");
        const path = new URL(String(input)).pathname;
        return new Response(JSON.stringify(path === "/api/v1/server"
          ? { serverId: "server-3", displayName: "Lumen", apiVersion: "1.0.0", setupRequired: false }
          : { setupRequired: true }), { status: 200 });
      },
    });

    expect((await client.discover()).setupRequired).toBe(true);
  });

  test("starts and monitors a library scan", async () => {
    const requests: Array<string> = [];
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/api/v1/scans") && init?.method === "POST") return new Response(JSON.stringify({ runId: ids.scanRun }), { status: 202 });
        return new Response(JSON.stringify({
          id: ids.scanRun,
          libraryId: ids.library,
          mode: "full",
          status: "succeeded",
          startedAtMs: 1,
          finishedAtMs: 2,
          errorCode: null,
          errorMessage: null,
          createdAtMs: 1,
        }), { status: 200 });
      },
    });
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "access", refreshToken: "refresh", accessExpiresAtMs: Date.now() + 900_000, refreshExpiresAtMs: Date.now() + 2_592_000_000 });

    const started = await client.startScan(ids.library, "full");
    const status = await client.scanStatus(started.runId);

    expect(started.runId).toBe(ids.scanRun);
    expect(status.status).toBe("succeeded");
    expect(requests).toEqual([
      `POST https://media.example/api/v1/scans`,
      `GET https://media.example/api/v1/scans/${ids.scanRun}`,
    ]);
  });

  test("ignores a stale renderer device ID when starting playback", async () => {
    let requestBody: unknown;
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          sessionId: ids.playbackSession,
          itemId: ids.track,
          sourceId: ids.source,
          title: "Track",
          streamUrl: "/stream",
          durationSeconds: 10,
          streams: [],
          grantExpiresInSeconds: 3_600,
          grantToken: "grant",
        }), { status: 201 });
      },
    });
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "access", refreshToken: "refresh", accessExpiresAtMs: Date.now() + 900_000, refreshExpiresAtMs: Date.now() + 2_592_000_000 });

    await Reflect.apply(client.startPlayback, client, [ids.track, ids.device]);

    expect(requestBody).toEqual({ trackId: ids.track });
  });
});
