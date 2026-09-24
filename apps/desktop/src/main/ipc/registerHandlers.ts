import {
  IpcPlayerDisplay,
  IpcPlayerSurfaceBounds,
  type IpcServerDiscovery,
} from "@lumen/contracts";
import { Schema } from "effect";
import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { IpcConnectionInput } from "../../../../../packages/contracts/src/ipc";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import { ServerClient } from "../api/ServerClient";
import type { PlaybackBridge } from "../player/PlaybackBridge";
import type { PlayerController } from "../player/PlayerController";
import type { PlayerOverlayWindow } from "../player/PlayerOverlayWindow";

const decode = <S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(value);
const requestId = (): string => crypto.randomUUID();

const trustedSender = (event: IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  return (
    url.startsWith("file://") ||
    url.startsWith("lumen://") ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//u.test(url)
  );
};

export interface IpcDependencies {
  readonly registry: AccountRegistry;
  readonly clients: Map<string, ServerClient>;
  readonly player: PlayerController;
  readonly bridge: PlaybackBridge;
  readonly installationId: string;
  readonly window: BrowserWindow;
  readonly overlay: PlayerOverlayWindow;
}

const activeClient = (dependencies: IpcDependencies): ServerClient => {
  const account = dependencies.registry.active();
  if (account === null) throw new Error("No active connection");
  const client = dependencies.clients.get(account.connectionId);
  if (client === undefined) throw new Error("Active connection is unavailable");
  return client;
};

const activeConnectionId = (dependencies: IpcDependencies): string => {
  const account = dependencies.registry.active();
  if (account === null) throw new Error("No active connection");
  return account.connectionId;
};

export const registerIpcHandlers = (dependencies: IpcDependencies): void => {
  const discoveredServers = new Map<string, IpcServerDiscovery>();
  let playerDisplay: IpcPlayerDisplay | null = null;
  const handle = <A>(
    name: string,
    action: (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => Promise<A>,
  ): void => {
    ipcMain.handle(name, async (event, ...args) => {
      if (!trustedSender(event)) throw new Error("IPC sender is not trusted");
      return action(event, ...args);
    });
  };

  handle("accounts:list", async () => {
    const result = await dependencies.registry.list();
    const active = result.accounts.find(
      (account) => account.connectionId === result.activeConnectionId,
    );
    if (active !== undefined && !dependencies.clients.has(active.connectionId)) {
      const client = new ServerClient({ origin: active.origin });
      const identity = await client.identity();
      if (identity.serverId !== active.serverId)
        throw new Error("Server identity changed; remove this connection and enroll it again");
      const session = await dependencies.registry.session(active.connectionId);
      if (session !== null) {
        client.setSession(session);
        const user = await client.me();
        if (user.role !== active.role) {
          await dependencies.registry.updateRole(active.connectionId, user.role);
          client.setSession({ ...session, role: user.role });
        }
        dependencies.clients.set(active.connectionId, client);
      } else {
        return { ...result, activeConnectionId: null };
      }
    }
    return await dependencies.registry.list();
  });
  handle("accounts:setup", async (_event, raw) => {
    const input = decode(
      Schema.Struct({
        origin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
      }),
      raw,
    );
    return new ServerClient({ origin: input.origin }).setupRequired();
  });
  handle("accounts:discover-server", async (_event, raw) => {
    const input = decode(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)), raw);
    const discovery = await new ServerClient({ origin: input }).discover();
    discoveredServers.set(discovery.origin, discovery);
    return discovery;
  });
  handle("accounts:connect", async (_event, raw) => {
    const input = decode(IpcConnectionInput, raw);
    const client = new ServerClient({ origin: input.origin });
    const discovery = discoveredServers.get(client.serverOrigin);
    if (discovery === undefined) throw new Error("Connect to the server first");
    const identity = await client.identity();
    if (identity.serverId !== discovery.identity.serverId)
      throw new Error("Server identity changed; connect to the server again");
    const session = await (discovery.setupRequired
      ? client.register(input, dependencies.installationId)
      : client.login(input, dependencies.installationId));
    const user = await client.me();
    const connectionId = requestId();
    await dependencies.registry.save({
      connectionId,
      serverId: identity.serverId,
      serverLabel: input.serverLabel,
      origin: client.serverOrigin,
      username: input.username,
      userId: session.userId,
      role: user.role,
      sessionId: session.sessionId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAtMs: session.accessExpiresAtMs,
      refreshExpiresAtMs: session.refreshExpiresAtMs,
    });
    dependencies.clients.set(connectionId, client);
    discoveredServers.delete(client.serverOrigin);
    return dependencies.registry.list();
  });
  handle("accounts:activate", async (_event, raw) => {
    const connectionId = decode(Schema.String, raw);
    const account = dependencies.registry.find(connectionId);
    if (account === null) throw new Error("Connection not found");
    const client =
      dependencies.clients.get(connectionId) ?? new ServerClient({ origin: account.origin });
    const identity = await client.identity();
    if (identity.serverId !== account.serverId)
      throw new Error("Server identity changed; remove this connection and enroll it again");
    const session = await dependencies.registry.session(connectionId);
    if (session === null) throw new Error("Connection credentials are unavailable; sign in again");
    client.setSession(session);
    const user = await client.me();
    if (user.role !== account.role) {
      await dependencies.registry.updateRole(connectionId, user.role);
      client.setSession({ ...session, role: user.role });
    }
    await dependencies.registry.activate(connectionId);
    dependencies.clients.set(connectionId, client);
    return dependencies.registry.list();
  });
  handle("accounts:remove", async (_event, raw) => {
    const connectionId = decode(Schema.String, raw);
    await dependencies.player.stop();
    dependencies.clients.delete(connectionId);
    await dependencies.registry.remove(connectionId);
    return dependencies.registry.list();
  });
  handle("library:list", async () => activeClient(dependencies).libraries());
  handle("library:items", async (_event, raw) => {
    const input = decode(
      Schema.Struct({ libraryId: Schema.String, cursor: Schema.NullOr(Schema.String) }),
      raw,
    );
    return activeClient(dependencies).items(input.libraryId, input.cursor);
  });
  handle("library:item-details", async (_event, raw) => activeClient(dependencies).itemDetails(decode(Schema.String, raw)));
  handle("library:item-children", async (_event, raw) => {
    const input = decode(Schema.Struct({ itemId: Schema.String, cursor: Schema.NullOr(Schema.String) }), raw);
    return activeClient(dependencies).itemChildren(input.itemId, input.cursor);
  });
  handle("library:next-up", async (_event, raw) => activeClient(dependencies).nextUp(decode(Schema.String, raw)));
  handle("library:artwork", async (_event, raw) => activeClient(dependencies).artworkDataUrl(decode(Schema.String, raw)));
  handle("library:search", async (_event, raw) => {
    const input = decode(
      Schema.Struct({ query: Schema.String, libraryId: Schema.NullOr(Schema.String) }),
      raw,
    );
    return activeClient(dependencies).search(input.query, input.libraryId);
  });
  handle("admin:listUsers", async () => activeClient(dependencies).users());
  handle("admin:createUser", async (_event, raw) =>
    activeClient(dependencies).createUser(
      decode(
        Schema.Struct({
          username: Schema.String,
          displayName: Schema.String,
          password: Schema.String,
          role: Schema.optional(Schema.Literals(["admin", "user", "guest"])),
        }),
        raw,
      ),
    ),
  );
  handle("admin:updateUser", async (_event, raw) => {
    const input = decode(
      Schema.Struct({
        userId: Schema.String,
        displayName: Schema.optional(Schema.String),
        password: Schema.optional(Schema.String),
        role: Schema.optional(Schema.Literals(["admin", "user", "guest"])),
        isActive: Schema.optional(Schema.Boolean),
      }),
      raw,
    );
    return activeClient(dependencies).updateUser(input.userId, input);
  });
  handle("admin:listLibraries", async () => activeClient(dependencies).adminLibraries());
  handle("admin:metadataSettings", async () => activeClient(dependencies).metadataSettings());
  handle("admin:updateMetadataSettings", async (_event, raw) => {
    const input = decode(Schema.Struct({ tmdbApiKey: Schema.NullOr(Schema.String) }), raw);
    return activeClient(dependencies).updateMetadataSettings(input.tmdbApiKey);
  });
  handle("admin:createLibrary", async (_event, raw) =>
    activeClient(dependencies).createLibrary(
      decode(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          slug: Schema.String,
          kind: Schema.Literals(["movies", "shows", "music"]),
        }),
        raw,
      ),
    ),
  );
  handle("admin:updateLibrary", async (_event, raw) => {
    const input = decode(
      Schema.Struct({
        libraryId: Schema.String,
        name: Schema.optional(Schema.String),
        slug: Schema.optional(Schema.String),
        kind: Schema.optional(Schema.Literals(["movies", "shows", "music"])),
        isEnabled: Schema.optional(Schema.Boolean),
      }),
      raw,
    );
    return activeClient(dependencies).updateLibrary(input.libraryId, input);
  });
  handle("admin:deleteLibrary", async (_event, raw) =>
    activeClient(dependencies).deleteLibrary(decode(Schema.String, raw)),
  );
  handle("admin:listRoots", async (_event, raw) =>
    activeClient(dependencies).libraryRoots(decode(Schema.String, raw)),
  );
  handle("admin:addRoot", async (_event, raw) =>
    activeClient(dependencies).addLibraryRoot(
      decode(
        Schema.Struct({
          id: Schema.String,
          libraryId: Schema.String,
          path: Schema.String,
          priority: Schema.Number,
        }),
        raw,
      ),
    ),
  );
  handle("admin:deleteRoot", async (_event, raw) =>
    activeClient(dependencies).deleteLibraryRoot(decode(Schema.String, raw)),
  );
  handle("admin:startScan", async (_event, raw) => {
    const input = decode(
      Schema.Struct({
        libraryId: Schema.String,
        mode: Schema.Literals(["full", "incremental", "refresh"]),
      }),
      raw,
    );
    return activeClient(dependencies).startScan(input.libraryId, input.mode);
  });
  handle("admin:scanStatus", async (_event, raw) =>
    activeClient(dependencies).scanStatus(decode(Schema.String, raw)),
  );
  handle("player:start", async (_event, raw) => {
    const input = decode(Schema.Struct({ itemId: Schema.String }), raw);
    const result = await dependencies.player.start({
      client: activeClient(dependencies),
      connectionId: activeConnectionId(dependencies),
      itemId: input.itemId,
    });
    const { grantToken: _grantToken, ...safe } = result;
    return safe;
  });
  handle("player:pause", async (_event, raw) => {
    const input = decode(Schema.Struct({ sessionId: Schema.String, paused: Schema.Boolean }), raw);
    return dependencies.player.pause(input.sessionId, input.paused);
  });
  handle("player:seek", async (_event, raw) => {
    const input = decode(
      Schema.Struct({ sessionId: Schema.String, positionSeconds: Schema.Number }),
      raw,
    );
    return dependencies.player.seek(input.sessionId, input.positionSeconds);
  });
  handle("player:volume", async (_event, raw) => {
    const input = decode(
      Schema.Struct({ sessionId: Schema.String, volume: Schema.Number, muted: Schema.Boolean }),
      raw,
    );
    return dependencies.player.volume(input.sessionId, input.volume, input.muted);
  });
  handle("player:surface", async (_event, raw) => {
    const bounds = decode(Schema.NullOr(IpcPlayerSurfaceBounds), raw);
    await dependencies.player.setSurface(bounds);
    dependencies.overlay.setVisible(bounds !== null);
    return { ok: true };
  });
  handle("player:select-audio", async (_event, raw) => {
    const input = decode(Schema.Struct({ sessionId: Schema.String, streamId: Schema.String }), raw);
    return dependencies.player.selectAudioStream(input.sessionId, input.streamId);
  });
  handle("player:select-subtitle", async (_event, raw) => {
    const input = decode(
      Schema.Struct({ sessionId: Schema.String, streamId: Schema.NullOr(Schema.String) }),
      raw,
    );
    return dependencies.player.selectSubtitleStream(input.sessionId, input.streamId);
  });
  handle("player:state", async () => dependencies.player.getState());
  handle("player:display", async (_event, raw) => {
    playerDisplay = decode(IpcPlayerDisplay, raw);
    dependencies.overlay.window.webContents.send("player:display", playerDisplay);
  });
  handle("player:display-state", async () => playerDisplay);
  handle("player:overlay-action", async (_event, raw) => {
    const action = decode(Schema.Literals(["back", "retry", "stop"]), raw);
    dependencies.window.webContents.send("player:overlay-action", action);
  });
  handle("player:fullscreen", async (_event, raw) => {
    dependencies.window.setFullScreen(decode(Schema.Boolean, raw));
    return dependencies.window.isFullScreen();
  });
  handle("player:fullscreen-state", async () => dependencies.window.isFullScreen());
  handle("player:stop", async () => {
    await dependencies.player.stop();
    return { ok: true };
  });
};

export const unregisterIpcHandlers = (): void => {
  for (const name of [
    "accounts:list",
    "accounts:setup",
    "accounts:discover-server",
    "accounts:connect",
    "accounts:activate",
    "accounts:remove",
    "library:list",
    "library:items",
    "library:search",
    "admin:listUsers",
    "admin:createUser",
    "admin:updateUser",
    "admin:listLibraries",
    "admin:metadataSettings",
    "admin:updateMetadataSettings",
    "admin:createLibrary",
    "admin:updateLibrary",
    "admin:deleteLibrary",
    "admin:listRoots",
    "admin:addRoot",
    "admin:deleteRoot",
    "admin:startScan",
    "admin:scanStatus",
    "player:start",
    "player:pause",
    "player:seek",
    "player:volume",
    "player:surface",
    "player:select-audio",
    "player:select-subtitle",
    "player:state",
    "player:display",
    "player:display-state",
    "player:overlay-action",
    "player:fullscreen",
    "player:fullscreen-state",
    "player:stop",
  ])
    ipcMain.removeHandler(name);
};
