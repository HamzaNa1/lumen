import { expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AccountSummary } from "@lumen/contracts";
import type { AccountRegistry } from "../../apps/desktop/src/main/accounts/AccountRegistry";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { errorMessage } from "../../packages/app/src/format";
import { electronTestExports, ipcHandlers } from "../helpers/electron";

mock.module("electron", () => electronTestExports);
const { registerIpcHandlers, unregisterIpcHandlers } = await import(
  "../../apps/desktop/src/main/ipc/registerHandlers"
);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
};

const origin = "http://accounts.test";
const serverId = crypto.randomUUID();
const account = (username: string): AccountSummary => ({
  connectionId: crypto.randomUUID(),
  serverId,
  origin,
  username,
  serverLabel: username,
  userId: crypto.randomUUID(),
  role: "user",
  secureStorageAvailable: true,
  lastConnectedAtMs: null,
});

test.each([false, true])("desktop sign-in retry feedback survives Electron IPC (setup=%s)", async (setupRequired) => {
  let authAttempts = 0;
  let saves = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/server")
      return Response.json({ serverId, displayName: "Test", apiVersion: "1.0.0" });
    if (path === "/api/v1/auth/setup") return Response.json({ setupRequired });
    if (path === `/api/v1/auth/${setupRequired ? "register" : "login"}`) {
      authAttempts += 1;
      return Response.json({ message: "Rate limit exceeded" }, {
        status: 429, headers: { "retry-after": "25" },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { send: () => undefined },
  });
  registerIpcHandlers({
    registry: { save: async () => { saves += 1; } },
    clients: new Map(),
    installationId: crypto.randomUUID(),
    window,
    overlay: { window },
    player: { getState: () => null },
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  const invoke = async (name: string, ...args: unknown[]) => {
    const handler = ipcHandlers.get(name);
    if (handler === undefined) throw new Error(`Missing handler ${name}`);
    try {
      return await handler({ senderFrame: { url: "file:///renderer/index.html" } }, ...args);
    } catch (cause) {
      // Electron preserves only the thrown error's message when crossing processes.
      throw new Error(`Error invoking remote method '${name}': ${(cause as Error).name}: ${(cause as Error).message}`);
    }
  };
  try {
    await invoke("accounts:discover-server", origin);
    const failure = await invoke("accounts:connect", {
      origin, serverLabel: "Test", username: "admin", password: "password",
    }).catch((cause: unknown) => cause);
    expect(errorMessage(failure, "Could not sign in"))
      .toBe("Rate limit exceeded Try again in 25 seconds.");
    expect(authAttempts).toBe(1);
    expect(saves).toBe(0);
  } finally {
    window.emit("closed");
    unregisterIpcHandlers();
    fetchMock.mockRestore();
  }
});

for (const change of [
  "switch",
  "replace active",
  "replace inactive",
  "remove active",
  "remove inactive",
] as const) {
  test(`desktop account ${change} cancels only the departing clients' pending requests`, async () => {
    const first = account("first");
    const second = account("second");
    let activeId: string | null = first.connectionId;
    const accounts = new Map([first, second].map((value) => [value.connectionId, value]));
    const requests: { signal: AbortSignal; answer: ReturnType<typeof deferred<Response>> }[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/search") {
        const answer = deferred<Response>();
        requests.push({ signal: init?.signal as AbortSignal, answer });
        // Ignore abort here: the client must reject even a transport that answers late.
        return answer.promise;
      }
      if (path === "/api/v1/server")
        return Response.json({
          serverId,
          displayName: "Test",
          apiVersion: "1.0.0",
          capabilities: { watchGroups: false },
        });
      if (path === "/api/v1/auth/setup") return Response.json({ setupRequired: false });
      const user = change === "replace inactive" ? second : first;
      if (path === "/api/v1/auth/login") {
        const sessionId = crypto.randomUUID();
        return Response.json({
          userId: user.userId,
          role: "user",
          sessionId,
          accessToken: `${sessionId}.${"x".repeat(43)}`,
          accessExpiresAtMs: Date.now() + 60_000,
        });
      }
      if (path === "/api/v1/auth/me")
        return Response.json({
          id: user.userId,
          username: user.username,
          displayName: user.username,
          role: "user",
          isActive: true,
          createdAtMs: 1,
          updatedAtMs: 1,
        });
      throw new Error(`Unexpected request ${path}`);
    });
    const clients = new Map(
      [first, second].map((value) => [value.connectionId, new ServerClient({ origin })]),
    );
    for (const value of [first, second]) {
      const sessionId = crypto.randomUUID();
      clients.get(value.connectionId)?.setSession({
        userId: value.userId,
        role: "user",
        sessionId,
        accessToken: `${sessionId}.${"x".repeat(43)}`,
        accessExpiresAtMs: Date.now() + 60_000,
      });
    }
    const registry = {
      active: () => accounts.get(activeId ?? "") ?? null,
      find: (id: string) => accounts.get(id) ?? null,
      list: async () => ({ accounts: [...accounts.values()], activeConnectionId: activeId }),
      activate: async (id: string) => {
        activeId = id;
      },
      save: async (value: Parameters<AccountRegistry["save"]>[0]) => {
        activeId = value.connectionId;
        accounts.set(value.connectionId, {
          ...value,
          secureStorageAvailable: true,
          lastConnectedAtMs: null,
        });
      },
      remove: async (id: string) => {
        accounts.delete(id);
        if (activeId === id) activeId = null;
      },
    };
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      webContents: { send: () => undefined },
    });
    let stops = 0;
    registerIpcHandlers({
      registry,
      clients,
      installationId: crypto.randomUUID(),
      window,
      overlay: { window },
      player: {
        getState: () => null,
        stop: async () => {
          stops += 1;
        },
      },
    } as unknown as Parameters<typeof registerIpcHandlers>[0]);
    const invoke = (name: string, ...args: unknown[]) => {
      const handler = ipcHandlers.get(name);
      if (handler === undefined) throw new Error(`Missing handler ${name}`);
      return handler({ senderFrame: { url: "file:///renderer/index.html" } }, ...args);
    };
    const pending = [
      invoke("library:search", { query: "pending", libraryId: null }).catch(
        (cause: unknown) => cause,
      ),
      clients
        .get(second.connectionId)
        ?.search("pending")
        .catch((cause: unknown) => cause),
    ];
    try {
      expect(requests).toHaveLength(2);
      if (change === "switch") await invoke("accounts:activate", second.connectionId);
      else if (change.startsWith("replace")) {
        const replacing = change === "replace active" ? first : second;
        await invoke("accounts:discover-server", origin);
        await invoke("accounts:connect", {
          origin,
          serverLabel: "Test",
          username: replacing.username,
          password: "password",
        });
      } else
        await invoke(
          "accounts:remove",
          change === "remove active" ? first.connectionId : second.connectionId,
        );
      const cancelled = [
        change !== "remove inactive",
        change === "replace inactive" || change === "remove inactive",
      ];
      expect(requests.map((request) => request.signal.aborted)).toEqual(cancelled);
      expect(stops).toBe(change === "remove inactive" ? 0 : 1);
      for (const request of requests) request.answer.resolve(Response.json({ items: [] }));
      const results = await Promise.all(pending);
      for (const [index, result] of results.entries()) {
        if (cancelled[index]) expect(result).toHaveProperty("name", "RequestCancelledError");
        else expect(result).toEqual({ items: [] });
      }
    } finally {
      for (const request of requests) request.answer.resolve(Response.json({ items: [] }));
      await Promise.all(pending);
      window.emit("closed");
      unregisterIpcHandlers();
      fetchMock.mockRestore();
    }
  });
}
