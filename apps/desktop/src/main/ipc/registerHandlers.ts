import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { Schema } from "effect";
import { IpcConnectionInput } from "../../../../../packages/contracts/src/ipc";
import { AccountRegistry } from "../accounts/AccountRegistry";
import { ServerClient } from "../api/ServerClient";
import { PlayerController } from "../player/PlayerController";
import { PlaybackBridge } from "../player/PlaybackBridge";

const decode = <S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): S["Type"] => Schema.decodeUnknownSync(schema)(value);
const requestId = (): string => crypto.randomUUID();

const trustedSender = (event: IpcMainInvokeEvent): boolean => {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  return url.startsWith("file://") || url.startsWith("lumen://") || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//u.test(url);
};

export interface IpcDependencies {
  readonly registry: AccountRegistry;
  readonly clients: Map<string, ServerClient>;
  readonly player: PlayerController;
  readonly bridge: PlaybackBridge;
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
  const handle = <A>(name: string, action: (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => Promise<A>): void => {
    ipcMain.handle(name, async (event, ...args) => {
      if (!trustedSender(event)) throw new Error("IPC sender is not trusted");
      return action(event, ...args);
    });
  };

  handle("accounts:list", async () => {
    const result = await dependencies.registry.list();
    const active = result.accounts.find((account) => account.connectionId === result.activeConnectionId);
    if (active !== undefined && !dependencies.clients.has(active.connectionId)) {
      const client = new ServerClient({ origin: active.origin });
      const identity = await client.identity();
      if (identity.serverId !== active.serverId) throw new Error("Server identity changed; remove this connection and enroll it again");
      const session = await dependencies.registry.session(active.connectionId);
      if (session !== null) {
        client.setSession(session);
        dependencies.clients.set(active.connectionId, client);
      }
    }
    return result;
  });
  handle("accounts:connect", async (_event, raw) => {
    const input = decode(IpcConnectionInput, raw);
    const client = new ServerClient({ origin: input.origin });
    const identity = await client.identity();
    const session = await client.login(input, requestId());
    const connectionId = requestId();
    await dependencies.registry.save({
      connectionId,
      serverId: identity.serverId,
      serverLabel: input.serverLabel,
      origin: client.serverOrigin,
      username: input.username,
      userId: session.userId,
      sessionId: session.sessionId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAtMs: session.accessExpiresAtMs,
      refreshExpiresAtMs: session.refreshExpiresAtMs,
    });
    dependencies.clients.set(connectionId, client);
    return dependencies.registry.list();
  });
  handle("accounts:activate", async (_event, raw) => {
    const connectionId = decode(Schema.String, raw);
    await dependencies.registry.activate(connectionId);
    const account = dependencies.registry.find(connectionId);
    if (account === null) throw new Error("Connection not found");
    const client = dependencies.clients.get(connectionId) ?? new ServerClient({ origin: account.origin });
    const identity = await client.identity();
    if (identity.serverId !== account.serverId) throw new Error("Server identity changed; remove this connection and enroll it again");
    const session = await dependencies.registry.session(connectionId);
    if (session === null) throw new Error("Connection credentials are unavailable; sign in again");
    client.setSession(session);
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
    const input = decode(Schema.Struct({ libraryId: Schema.String, cursor: Schema.NullOr(Schema.String) }), raw);
    return activeClient(dependencies).items(input.libraryId, input.cursor);
  });
  handle("library:search", async (_event, raw) => {
    const input = decode(Schema.Struct({ query: Schema.String, libraryId: Schema.NullOr(Schema.String) }), raw);
    return activeClient(dependencies).search(input.query, input.libraryId);
  });
  handle("player:start", async (_event, raw) => {
    const input = decode(Schema.Struct({ itemId: Schema.String, deviceId: Schema.String }), raw);
    const result = await dependencies.player.start({
      client: activeClient(dependencies),
      connectionId: activeConnectionId(dependencies),
      itemId: input.itemId,
      deviceId: input.deviceId,
    });
    const { grantToken: _grantToken, ...safe } = result;
    return safe;
  });
  handle("player:pause", async (_event, raw) => {
    const input = decode(Schema.Struct({ sessionId: Schema.String, paused: Schema.Boolean }), raw);
    return dependencies.player.pause(input.sessionId, input.paused);
  });
  handle("player:seek", async (_event, raw) => {
    const input = decode(Schema.Struct({ sessionId: Schema.String, positionSeconds: Schema.Number }), raw);
    return dependencies.player.seek(input.sessionId, input.positionSeconds);
  });
  handle("player:state", async () => dependencies.player.getState());
  handle("player:stop", async () => {
    await dependencies.player.stop();
    return { ok: true };
  });
};

export const unregisterIpcHandlers = (): void => {
  for (const name of ["accounts:list", "accounts:connect", "accounts:activate", "accounts:remove", "library:list", "library:items", "library:search", "player:start", "player:pause", "player:seek", "player:state", "player:stop"]) ipcMain.removeHandler(name);
};
