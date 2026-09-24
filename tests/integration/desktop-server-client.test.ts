import { describe, expect, test } from "bun:test";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { ids } from "../../packages/testkit/src/ids";

describe("ServerClient discovery", () => {
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
    expect(requests).toEqual(["http://localhost:3210/api/v1/server"]);
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
    client.setSession({ userId: ids.user, role: "admin", sessionId: ids.authSession, accessToken: "access", refreshToken: "refresh", accessExpiresAtMs: 10_000, refreshExpiresAtMs: 20_000 });

    const started = await client.startScan(ids.library, "full");
    const status = await client.scanStatus(started.runId);

    expect(started.runId).toBe(ids.scanRun);
    expect(status.status).toBe("succeeded");
    expect(requests).toEqual([
      `POST https://media.example/api/v1/scans`,
      `GET https://media.example/api/v1/scans/${ids.scanRun}`,
    ]);
  });
});
