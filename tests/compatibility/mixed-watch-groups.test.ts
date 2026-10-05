import { afterEach, expect, test } from "bun:test";
import {
  PlaybackUnsupportedError,
  type WatchConnection,
  WatchGroupClient,
  WatchPlaybackController,
  type WatchPlayer,
  type WatchServer,
} from "../../packages/client/src/index.ts";
import { eventually } from "../helpers/eventually";
import { watchFixture } from "../helpers/watch-groups";

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
  buffer() {
    return { aheadSeconds: Number.POSITIVE_INFINITY, starved: false, settled: false };
  }
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

test("a browser that cannot play the file releases its join hold without stopping the group", async () => {
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
    // Joining holds the group, then the failed viewer releases it without retrying the file.
    expect(desktop.status.group?.revision).toBe((before?.revision ?? 0) + 2);
    expect(desktop.status.group?.playback).toMatchObject({ itemId: fixture.itemId, paused: false });
    expect(desktop.status.group?.playback?.waitingFor).toBeUndefined();
    expect(desktop.status.group?.playback?.positionSeconds).toBeGreaterThanOrEqual(5);
    const released = desktop.status.group;
    expect(desktop.status.group?.members).toHaveLength(2);

    // Leaving the player after the failure is not a request to stop for everyone: neither the
    // stop Back makes, nor the one that follows when the player's route is torn down.
    await browser.stop();
    await browser.stop();
    await Bun.sleep(200);
    expect(desktop.status.group?.revision).toBe(released?.revision);
    expect(desktop.status.group?.playback).toEqual(released?.playback ?? null);

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

test("a player that breaks mid-playback is not mistaken for the viewer stopping the group", async () => {
  const fixture = await watchFixture();
  const origin = fixture.running.server.url.origin;
  const player = new BrowserPlayer();
  const browser = new WatchPlaybackController(player, () => undefined);
  try {
    const desktop = await fixture.connect(await fixture.login());
    await desktop.action({ type: "create", name: "Movie night", password: "" });
    await desktop.action({ type: "play", itemId: fixture.itemId, positionSeconds: 5 });
    browserSockets({ cookie: await browserLogin(origin), origin });
    browser.connect(cookieServer(origin), "web");
    browser.setSurfaceReady(true);
    await eventually(() => browser.status.connection === "connected");
    await browser.action({ type: "join", groupId: desktop.status.group?.id ?? "", password: "" });
    await eventually(() => player.state?.paused === false);
    await eventually(() => desktop.status.group?.members.length === 2);
    const before = desktop.status.group;

    // The browser hits a frame it cannot decode: its player gives up and reports why.
    player.state = null;
    player.unsupported = true;
    browser.playerFailed(new PlaybackUnsupportedError("This browser can’t play this file’s format."));
    expect(browser.status.error).toContain("can’t play this file’s format");
    const starts = player.starts;
    // The viewer presses Back, and leaving the player's route stops once more.
    await browser.stop();
    await browser.stop();
    await Bun.sleep(700);
    expect(desktop.status.group?.revision).toBe(before?.revision);
    expect(desktop.status.group?.playback).toEqual(before?.playback ?? null);
    expect(player.starts).toBe(starts);

    // Another participant changes playback while the failed viewer's route is being removed.
    // That revision must not turn a later cleanup into a group-wide stop.
    browser.setSurfaceReady(false);
    await desktop.action({ type: "seek", itemId: fixture.itemId, positionSeconds: 30 });
    // The group holds at the new position for its members to load it.
    await eventually(() => browser.status.group?.revision === (before?.revision ?? 0) + 1);
    await browser.stop();
    // It does not go on waiting for a viewer who has given up on this device.
    await eventually(() => desktop.status.group?.playback?.paused === false);
    const changed = desktop.status.group;
    expect(changed?.playback).toMatchObject({ positionSeconds: 30, paused: false });
    await Bun.sleep(200);
    expect(desktop.status.group?.revision).toBe(changed?.revision);
    expect(desktop.status.group?.playback).toEqual(changed?.playback ?? null);
    expect(player.starts).toBe(starts);

    // Once local playback has recovered, a deliberate stop controls the group again.
    player.unsupported = false;
    browser.setSurfaceReady(true);
    await desktop.action({ type: "play", itemId: fixture.itemId, positionSeconds: 35 });
    await eventually(() => player.state?.paused === false);
    await browser.stop();
    await eventually(() => desktop.status.group?.playback === null);
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
