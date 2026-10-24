import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test as base, expect } from "@playwright/test";

import { collectBrowserErrors } from "./browser-errors";
import { collectBrowserCoverage } from "./coverage";

export const repository = resolve(import.meta.dirname, "../../..");
export const password = "correct horse battery staple";
export interface Account {
  accessToken: string;
  sessionId: string;
  userId: string;
  deviceId: string;
}
export interface Item {
  id: string;
  title: string;
  kind: string;
  parentId: string | null;
  indexNumber: number | null;
  indexNumberEnd: number | null;
}
export interface Playback {
  sessionId: string;
  grantToken: string;
  streamUrl: string;
  trackId: string;
  streams: { id: string; kind: string; codec: string }[];
}

export class Server {
  origin = "";
  readonly log: string[] = [];
  private child: ChildProcess | undefined;
  private environment: NodeJS.ProcessEnv = {};
  constructor(
    readonly root: string,
    readonly mediaFormat = "mp4",
  ) {}
  get databasePath() {
    return join(this.root, "server.sqlite");
  }
  async start(overrides: NodeJS.ProcessEnv = {}) {
    this.environment = overrides;
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("LUMEN_")),
    );
    const child = spawn("bun", [join(repository, "tests/e2e/support/server-entry.ts")], {
      cwd: repository,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...environment,
        LUMEN_COVERAGE_DIR: process.env.LUMEN_COVERAGE_DIR,
        LUMEN_DATABASE_PATH: this.databasePath,
        LUMEN_DATA_DIR: this.root,
        LUMEN_HOST: "127.0.0.1",
        LUMEN_WEB_APP: "required",
        LUMEN_LOG_FORMAT: "json",
        LUMEN_MAX_REQUESTS_PER_MINUTE: "100000",
        LUMEN_LOGIN_ATTEMPTS_PER_MINUTE: "1000",
        ...overrides,
      },
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.log.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.log.push(chunk.toString()));
    const abort = new AbortController();
    const timeout = AbortSignal.timeout(30_000);
    timeout.addEventListener("abort", () => abort.abort(timeout.reason), {
      once: true,
      signal: abort.signal,
    });
    try {
      this.origin = await Promise.race([
        once(child, "message", { signal: abort.signal }).then(([message]) => {
          if (typeof message?.origin !== "string")
            throw new Error("Server did not report an origin");
          return message.origin as string;
        }),
        once(child, "exit", { signal: abort.signal }).then(([code]) => {
          throw new Error(`Server exited (${code}): ${this.log.join("")}`);
        }),
      ]);
      expect((await this.request("/health/ready")).status).toBe(200);
    } finally {
      abort.abort();
    }
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    // Closing IPC invokes the entrypoint's graceful shutdown on Windows as well as POSIX.
    child.disconnect();
    const deadline = AbortSignal.timeout(15_000);
    const kill = () => child.kill("SIGKILL");
    deadline.addEventListener("abort", kill, { once: true });
    try {
      const [code, signal] = await exited;
      expect({ code, signal }, this.log.join("")).toEqual({ code: 0, signal: null });
    } finally {
      deadline.removeEventListener("abort", kill);
    }
    this.child = undefined;
  }
  async restart() {
    await this.stop();
    await this.start(this.environment);
  }
  async advanceTime(advanceMs: number) {
    const child = this.child;
    if (!child?.connected) throw new Error("Server is not connected");
    const id = crypto.randomUUID();
    const acknowledged = once(child, "message", { signal: AbortSignal.timeout(5000) });
    child.send({ id, advanceMs });
    expect((await acknowledged)[0]).toEqual({ id });
  }
  request(path: string, init: RequestInit = {}) {
    return fetch(new URL(path, this.origin), {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  }
  async api<T = unknown>(
    path: string,
    {
      token,
      body,
      method = body === undefined ? "GET" : "POST",
      status = method === "POST" ? 201 : 200,
    }: {
      token?: string;
      body?: unknown;
      method?: string;
      status?: number;
    } = {},
  ): Promise<T> {
    const response = await this.request(`/api/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(response.status, `${method} ${path}: ${text}`).toBe(status);
    return (text ? JSON.parse(text) : null) as T;
  }
  register(username = "admin") {
    return this.api<Account>("/auth/register", {
      body: {
        username,
        displayName: username,
        password,
        deviceId: crypto.randomUUID(),
        deviceName: "E2E",
        platform: "desktop",
        platformDeviceId: null,
      },
    });
  }
  login(username = "admin") {
    return this.api<Account>("/auth/login", {
      status: 200,
      body: {
        username,
        password,
        deviceId: crypto.randomUUID(),
        deviceName: "E2E",
        platform: "desktop",
        platformDeviceId: null,
      },
    });
  }
  async library(token: string, kind: "movies" | "shows" | "music", files: readonly string[]) {
    const id = crypto.randomUUID();
    const path = join(this.root, id);
    await mkdir(path);
    for (const name of files) await this.media(path, name);
    await this.api("/libraries", { token, body: { id, name: kind, slug: id, kind } });
    const rootId = crypto.randomUUID();
    await this.api(`/libraries/${id}/roots`, {
      token,
      body: { id: rootId, libraryId: id, path, priority: 0 },
    });
    await this.scan(token, id);
    return { id, path, rootId };
  }
  async media(root: string, name: string) {
    const destination = join(
      root,
      this.mediaFormat === "webm" ? name.replace(/\.(mp4|mkv)$/i, ".webm") : name,
    );
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repository, `tests/fixtures/playback.${this.mediaFormat}`), destination);
    return destination;
  }
  async scan(token: string, libraryId: string, mode = "incremental") {
    const run = await this.api<{ runId: string }>("/scans", {
      token,
      status: 202,
      body: { libraryId, mode },
    });
    await expect
      .poll(
        async () => (await this.api<{ status: string }>(`/scans/${run.runId}`, { token })).status,
        { timeout: 30_000 },
      )
      .toBe("succeeded");
    return this.api<Record<string, unknown>>(`/scans/${run.runId}`, { token });
  }
  async items(token: string, libraryId: string) {
    return (await this.api<{ items: Item[] }>(`/items?libraryId=${libraryId}&limit=100`, { token }))
      .items;
  }
  play(token: string, itemId: string) {
    return this.api<Playback>("/playback/sessions", { token, body: { trackId: itemId } });
  }
}

export const test = base.extend<{ server: Server; admin: Account }, { processCoverage: undefined }>(
  {
    processCoverage: [
      async ({ playwright: _playwright }, use) => {
        await use(undefined);
        if (process.env.LUMEN_COVERAGE_DIR)
          await writeFile(
            join(process.env.LUMEN_COVERAGE_DIR, `${crypto.randomUUID()}.json`),
            JSON.stringify(
              (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__ ?? {},
            ),
          );
      },
      { scope: "worker", auto: true },
    ],
    context: async ({ context }, use) => {
      const errors = await collectBrowserErrors(context);
      const flush = await collectBrowserCoverage(context);
      try {
        await use(context);
      } finally {
        await flush();
        expect(errors, "Uncaught browser errors").toEqual([]);
      }
    },
    server: async ({ playwright: _playwright }, use, testInfo) => {
      const server = new Server(
        await mkdtemp(join(tmpdir(), "lumen-e2e-")),
        ["firefox", "webkit"].includes(testInfo.project.name) ? "webm" : "mp4",
      );
      try {
        await server.start();
        await use(server);
      } finally {
        await server.stop();
        const path = testInfo.outputPath("server.log");
        await writeFile(path, server.log.join(""));
        await testInfo.attach("server log", { path, contentType: "text/plain" });
        await rm(server.root, { recursive: true, force: true });
      }
    },
    admin: async ({ server }, use) => {
      await use(await server.register());
    },
  },
);
export { expect } from "@playwright/test";
