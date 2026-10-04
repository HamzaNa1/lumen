import { afterEach, expect, test } from "bun:test";
import {
  PlaybackUnsupportedError,
  type WatchConnection,
  WatchGroupClient,
  WatchPlaybackController,
  type WatchPlayer,
  type WatchServer,
} from "../../packages/client/src/index.ts";
import { eventually, watchFixture } from "../helpers/watch-groups";

const NativeWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = NativeWebSocket;
});

/** Makes sockets behave like a browser page's: they carry its cookie and its Origin. */
const browserSockets = (headers: Record<string, string>): void => {
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL) {
      super(url, { headers } as never);
    }
  } as typeof WebSocket;
};

const browserLogin = async (origin: string, username = "admin"): Promise<string> => {
  const response = await fetch(new URL("/api/v1/auth/browser/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-lumen-csrf": "1" },
    body: JSON.stringify({
      username,
      password: "correct horse battery staple",
      deviceId: crypto.randomUUID(),
      deviceName: "Test browser",
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
};

const cookieServer = (origin: string): WatchServer => ({
  serverOrigin: origin,
  supportsWatchGroups: true,
  watchAuthentication: () => ({ session: "cookie" }),
});

type Local = { itemId: string; positionSeconds: number; paused: boolean; sessionId: string };

/** A browser player as watch groups see it. `unsupported` models a file the browser can't decode. */
class BrowserPlayer implements WatchPlayer<WatchServer> {
  state: (Local & { durationSeconds: number }) | null = null;
  starts = 0;
  unsupported = false;
  async start(input: { itemId: string; startAtSeconds?: number; paused?: boolean }) {
    this.starts += 1;
    if (this.unsupported)
      throw new PlaybackUnsupportedError("This browser can’t play this file’s format.");
    this.state = {
      sessionId: crypto.randomUUID(),
      itemId: input.itemId,
      positionSeconds: input.startAtSeconds ?? 0,
      durationSeconds: 100,
      paused: input.paused ?? false,
    };
  }
  async stop() {
    this.state = null;
  }
  getState() {
    return this.state;
  }
  async seek(_sessionId: string, positionSeconds: number) {
    if (this.state !== null) this.state = { ...this.state, positionSeconds };
  }
  async pause(_sessionId: string, paused: boolean) {
    if (this.state !== null) this.state = { ...this.state, paused };
  }
  async speed() {}
}

test("a desktop viewer and a browser viewer share one group and follow each other's commands", async () => {
  const fixture = await watchFixture();
  const origin = fixture.running.server.url.origin;
  const player = new BrowserPlayer();
  const browser = new WatchPlaybackController(player, () => undefined);
  try {
    const desktop = await fixture.connect(await fixture.login());
    await desktop.action({ type: "create", name: "Movie night", password: "together" });
    await desktop.action({ type: "play", itemId: fixture.itemId, positionSeconds: 12 });

    browserSockets({ cookie: await browserLogin(origin), origin });
    browser.connect(cookieServer(origin), "web");
    browser.setSurfaceReady(true);
    await eventually(() => browser.status.connection === "connected");
    await browser.action({ type: "join", groupId: desktop.status.group?.id ?? "", password: "together" });
    await eventually(() => player.state?.itemId === fixture.itemId && player.state.paused === false);
    expect(player.state?.positionSeconds).toBeGreaterThanOrEqual(12);
    await eventually(() => desktop.status.group?.members.length === 2);

    // The browser viewer pauses for everyone.
    await browser.action({ type: "pause", itemId: fixture.itemId, paused: true, positionSeconds: 20 });
    await eventually(() => desktop.status.group?.playback?.paused === true);
    expect(desktop.status.group?.playback?.positionSeconds).toBe(20);
    await eventually(() => player.state?.paused === true && player.state.positionSeconds === 20);

    // The desktop viewer seeks for everyone.
    await desktop.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 45 });
    await eventually(() => player.state?.positionSeconds === 45);

    // Leaving stops only the browser's own player.
    await browser.action({ type: "leave" });
    await eventually(() => desktop.status.group?.members.length === 1);
    expect(desktop.status.group?.playback?.itemId).toBe(fixture.itemId);
  } finally {
    browser.close();
    await fixture.close();
  }
});

test("a browser that cannot play the file leaves the group's playback untouched", async () => {
  const fixture = await watchFixture();
  const origin = fixture.running.server.url.origin;
  const player = new BrowserPlayer();
  player.unsupported = true;
  const statuses: (string | null)[] = [];
  const browser = new WatchPlaybackController(player, (status) => statuses.push(status.error));
  try {
    const desktop = await fixture.connect(await fixture.login());
    await desktop.action({ type: "create", name: "Movie night", password: "" });
    await desktop.action({ type: "play", itemId: fixture.itemId, positionSeconds: 5 });
    const before = desktop.status.group;

    browserSockets({ cookie: await browserLogin(origin), origin });
    browser.connect(cookieServer(origin), "web");
    browser.setSurfaceReady(true);
    await eventually(() => browser.status.connection === "connected");
    await browser.action({ type: "join", groupId: before?.id ?? "", password: "" });
    await eventually(() => browser.status.error !== null);
    expect(browser.status.error).toContain("can’t play this file’s format");
    // Trying again cannot help, so the player is not started over and over.
    await Bun.sleep(1_300);
    expect(player.starts).toBe(1);
    // Nothing was paused, sought or stopped on the group's behalf.
    expect(desktop.status.group?.revision).toBe(before?.revision);
    expect(desktop.status.group?.playback).toEqual(before?.playback ?? null);
    expect(desktop.status.group?.members).toHaveLength(2);

    // The viewer stays in the group, and plays along once the group moves to something else.
    player.unsupported = false;
    await desktop.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 30 });
    await eventually(() => player.state?.positionSeconds !== undefined);
    expect(browser.status.error).toBeNull();
  } finally {
    browser.close();
    await fixture.close();
  }
});

test("a suspended browser tab reconnects, rejoins and catches up when it resumes", async () => {
  const fixture = await watchFixture();
  const origin = fixture.running.server.url.origin;
  const player = new BrowserPlayer();
  const browser = new WatchPlaybackController(player, () => undefined);
  try {
    const desktop = await fixture.connect(await fixture.login());
    await desktop.action({ type: "create", name: "Movie night", password: "together" });
    await desktop.action({ type: "play", itemId: fixture.itemId, positionSeconds: 1 });
    browserSockets({ cookie: await browserLogin(origin), origin });
    browser.connect(cookieServer(origin), "web");
    browser.setSurfaceReady(true);
    await eventually(() => browser.status.connection === "connected");
    await browser.action({ type: "join", groupId: desktop.status.group?.id ?? "", password: "together" });
    await eventually(() => player.state !== null);
    const memberId = browser.status.memberId;

    // The tab was frozen long enough for its connection to go quiet.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      browser.resume();
    } finally {
      Date.now = realNow;
    }
    await desktop.action({ type: "pause", itemId: fixture.itemId, paused: true, positionSeconds: 33 });
    await eventually(
      () => browser.status.connection === "connected" && browser.status.memberId !== memberId,
    );
    await eventually(() => player.state?.paused === true && player.state.positionSeconds === 33);
    expect(desktop.status.group?.members).toHaveLength(2);
  } finally {
    browser.close();
    await fixture.close();
  }
});

test("a cookie handshake needs this origin's cookie; a signed-out browser is disconnected", async () => {
  const fixture = await watchFixture();
  const origin = fixture.running.server.url.origin;
  const clients: WatchGroupClient[] = [];
  const connect = (connection: WatchConnection) => {
    const client = new WatchGroupClient(connection, () => undefined);
    clients.push(client);
    client.connect();
    return client;
  };
  try {
    const cookie = await browserLogin(origin);

    // Another site's page: the browser would attach the cookie, but the Origin gives it away.
    browserSockets({ cookie, origin: "https://evil.example" });
    const foreign = connect(cookieServer(origin));
    // No Origin at all is not a browser page, so it may not stand on a cookie.
    browserSockets({ cookie });
    const headless = connect(cookieServer(origin));
    // This origin, but no session.
    browserSockets({ origin });
    const anonymous = connect(cookieServer(origin));
    await Bun.sleep(700);
    for (const client of [foreign, headless, anonymous])
      expect(client.status.connection).not.toBe("connected");
    for (const client of clients.splice(0)) client.close();

    browserSockets({ cookie, origin });
    const signedIn = connect(cookieServer(origin));
    await eventually(() => signedIn.status.connection === "connected");
    const logout = await fetch(new URL("/api/v1/auth/browser/logout", origin), {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin, "x-lumen-csrf": "1" },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    // The session is checked again on every request, not only at the handshake.
    await signedIn.action({ type: "list" }).catch(() => undefined);
    await eventually(() => signedIn.status.connection !== "connected");
  } finally {
    for (const client of clients) client.close();
    await fixture.close();
  }
});
