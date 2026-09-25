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
  test("exchanges a legacy credential for a saved session token", async () => {
    const requests: string[] = [];
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (input, init) => {
        requests.push(new URL(String(input)).pathname);
        expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "legacy-refresh" });
        return new Response(JSON.stringify({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: `${ids.authSession}.new-secret`, accessExpiresAtMs: Date.now() + 1_000 }), { status: 200 });
      },
    });
    const session = await client.migrateLegacySession("legacy-refresh");
    expect(session.accessToken).toBe(client.currentSession?.accessToken);
    expect(requests).toEqual(["/api/v1/auth/migrate-session"]);
  });

  test("reuses the saved session token without a refresh request", async () => {
    const calls: string[] = [];
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        expect(path).toBe("/api/v1/test");
        calls.push(`request ${new Headers(init?.headers).get("authorization")}`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "saved-session", accessExpiresAtMs: 1 });
    expect(await client.request("/api/v1/test")).toEqual({ ok: true });
    expect(calls).toEqual(["request Bearer saved-session"]);
  });

  test("reports an expired session so the user can sign in", async () => {
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async () => new Response(JSON.stringify({ message: "Session is invalid" }), { status: 401 }),
    });
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "saved-session", accessExpiresAtMs: 1 });
    expect(client.request("/api/v1/test")).rejects.toThrow("Session is invalid");
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

  test("starts and monitors a library scan and reads its job log", async () => {
    const requests: Array<string> = [];
    const client = new ServerClient({
      origin: "https://media.example",
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/api/v1/scans") && init?.method === "POST") return new Response(JSON.stringify({ runId: ids.scanRun }), { status: 202 });
        if (url.endsWith("/api/v1/admin/jobs?limit=100")) return new Response(JSON.stringify([{
          id: ids.scanJob,
          runId: ids.scanRun,
          libraryId: ids.library,
          libraryName: "Movies",
          mode: "full",
          operation: "discover",
          status: "succeeded",
          attempts: 1,
          maxAttempts: 3,
          availableAtMs: 1,
          startedAtMs: 1,
          finishedAtMs: 2,
          errorCode: null,
          errorMessage: null,
        }]), { status: 200 });
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
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "access", accessExpiresAtMs: Date.now() + 900_000 });

    const started = await client.startScan(ids.library, "full");
    const status = await client.scanStatus(started.runId);
    const jobs = await client.jobLog();

    expect(started.runId).toBe(ids.scanRun);
    expect(status.status).toBe("succeeded");
    expect(jobs[0]?.operation).toBe("discover");
    expect(requests).toEqual([
      `POST https://media.example/api/v1/scans`,
      `GET https://media.example/api/v1/scans/${ids.scanRun}`,
      "GET https://media.example/api/v1/admin/jobs?limit=100",
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
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "access", accessExpiresAtMs: Date.now() + 900_000 });

    await Reflect.apply(client.startPlayback, client, [ids.track, ids.device]);

    expect(requestBody).toEqual({ trackId: ids.track });
  });
});
