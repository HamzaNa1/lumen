import {
  HomePreferences,
  IpcAudioOutput,
  IpcPlayerDisplay,
  IpcPlayerSurfaceBounds,
  type IpcServerDiscovery,
} from "@lumen/contracts";
import { Schema } from "effect";
import { type BrowserWindow, type IpcMainInvokeEvent, clipboard, ipcMain } from "electron";
import { IpcConnectionInput } from "../../../../../packages/contracts/src/ipc";
import type { AccountRegistry } from "../accounts/AccountRegistry";
import { deviceIdForAccount } from "../accounts/InstallationId";
import { ServerClient, ServerHttpError, type AccountSession } from "../api/ServerClient";
import type { PlaybackBridge } from "../player/PlaybackBridge";
import type { PlayerController } from "../player/PlayerController";
import type { PlayerOverlayWindow } from "../player/PlayerOverlayWindow";

const decode = <S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(value);
const requestId = (): string => crypto.randomUUID();
const hasSessionToken = (session: AccountSession | null): boolean =>
  typeof session?.accessToken === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u.test(session.accessToken);

const validateClient = async (client: ServerClient) => {
  try { return await client.me(); }
  catch (cause) {
    if (cause instanceof ServerHttpError && cause.status === 401) throw new Error("Sign-in required");
    throw cause;
  }
};

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
  const restoring = new Map<string, Promise<ServerClient>>();
  let playerDisplay: IpcPlayerDisplay | null = null;
  const restoreClient = (account: { readonly connectionId: string; readonly origin: string; readonly serverId: string; readonly role: "admin" | "user" | "guest" }): Promise<ServerClient> => {
    const cached = dependencies.clients.get(account.connectionId);
    if (cached !== undefined) return validateClient(cached).then(() => cached);
    const pending = restoring.get(account.connectionId);
    if (pending !== undefined) return pending;
    const next = (async () => {
      const client = new ServerClient({ origin: account.origin });
      const identity = await client.identity();
      if (identity.serverId !== account.serverId) throw new Error("Server identity changed; remove this connection and enroll it again");
      const session = await dependencies.registry.session(account.connectionId);
      if (session !== null && hasSessionToken(session)) client.setSession(session);
      else if (session !== null && typeof session.refreshToken === "string") {
        const migrated = await client.migrateLegacySession(session.refreshToken).catch((cause) => {
          if (cause instanceof ServerHttpError && cause.status === 401) throw new Error("Sign-in required");
          throw cause;
        });
        await dependencies.registry.updateSession(account.connectionId, migrated);
      } else throw new Error("Sign-in required");
      const user = await validateClient(client);
      if (user.role !== account.role) {
        await dependencies.registry.updateRole(account.connectionId, user.role);
        const current = client.currentSession;
        if (current !== null) client.setSession({ ...current, role: user.role });
      }
      dependencies.clients.set(account.connectionId, client);
      return client;
    })().finally(() => { restoring.delete(account.connectionId); });
    restoring.set(account.connectionId, next);
    return next;
  };
  const handle = <A>(
    name: string,
    action: (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => Promise<A>,
  ): void => {
    ipcMain.handle(name, async (event, ...args) => {
      if (!trustedSender(event)) throw new Error("IPC sender is not trusted");
      return action(event, ...args);
    });
  };

  handle("accounts:list", async () => dependencies.registry.list());
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
    let connectionId = requestId();
    const client = new ServerClient({ origin: input.origin });
    const discovery = discoveredServers.get(client.serverOrigin);
    if (discovery === undefined) throw new Error("Connect to the server first");
    const identity = await client.identity();
    if (identity.serverId !== discovery.identity.serverId)
      throw new Error("Server identity changed; connect to the server again");
    const deviceId = deviceIdForAccount(dependencies.installationId, identity.serverId, input.username);
    const setupRequired = await client.setupRequired(discovery.setupRequired);
    const session = await (setupRequired || input.signUp === true
      ? client.register(input, deviceId)
      : client.login(input, deviceId));
    const user = await client.me();
    const current = client.currentSession ?? session;
    connectionId = (await dependencies.registry.list()).accounts.find((account) => account.serverId === identity.serverId && account.userId === session.userId)?.connectionId ?? connectionId;
    try {
      await dependencies.registry.save({
        connectionId,
        serverId: identity.serverId,
        serverLabel: input.serverLabel,
        origin: client.serverOrigin,
        username: input.username,
        userId: session.userId,
        role: user.role,
        sessionId: current.sessionId,
        accessToken: current.accessToken,
        accessExpiresAtMs: current.accessExpiresAtMs,
      });
    } catch (cause) {
      throw new Error(`${setupRequired || input.signUp === true ? "Account created" : "Sign-in succeeded"}, but this device could not save the connection. Sign in with the same credentials to retry.`, { cause });
    }
    dependencies.clients.set(connectionId, client);
    discoveredServers.delete(client.serverOrigin);
    return dependencies.registry.list();
  });
  handle("accounts:activate", async (_event, raw) => {
    const connectionId = decode(Schema.String, raw);
    const account = dependencies.registry.find(connectionId);
    if (account === null) throw new Error("Connection not found");
    await restoreClient(account);
    await dependencies.registry.activate(connectionId);
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
  handle("library:home", async () => activeClient(dependencies).home());
  handle("library:home-preferences", async () => activeClient(dependencies).homePreferences());
  handle("library:save-home-preferences", async (_event, raw) =>
    activeClient(dependencies).saveHomePreferences(decode(HomePreferences, raw)),
  );
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
  handle("admin:jobLog", async () => activeClient(dependencies).jobLog());
  handle("player:start", async (_event, raw) => {
    const input = decode(
      Schema.Struct({ itemId: Schema.String, startAtSeconds: Schema.optional(Schema.Number) }),
      raw,
    );
    const result = await dependencies.player.start({
      client: activeClient(dependencies),
      connectionId: activeConnectionId(dependencies),
      itemId: input.itemId,
      ...(input.startAtSeconds === undefined ? {} : { startAtSeconds: input.startAtSeconds }),
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
  handle("player:audio-output", async (_event, raw) => {
    const input = decode(Schema.Struct({ sessionId: Schema.String, output: IpcAudioOutput }), raw);
    return dependencies.player.setAudioOutput(input.sessionId, input.output);
  });
  handle("player:copy-audio-diagnostics", async (_event, raw) => {
    const sessionId = decode(Schema.String, raw);
    await clipboard.writeText(await dependencies.player.audioDiagnostics(sessionId));
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
    "library:home",
    "library:home-preferences",
    "library:save-home-preferences",
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
    "admin:jobLog",
    "player:start",
    "player:pause",
    "player:seek",
    "player:volume",
    "player:surface",
    "player:select-audio",
    "player:select-subtitle",
    "player:state",
    "player:audio-output",
    "player:copy-audio-diagnostics",
    "player:display",
    "player:display-state",
    "player:overlay-action",
    "player:fullscreen",
    "player:fullscreen-state",
    "player:stop",
  ])
    ipcMain.removeHandler(name);
};
