import { Context, Effect, Layer } from "effect";
import type { ServerConfig } from "./Config";
import { decodeConfig } from "./Config";

export class ServerConfigService extends Context.Service<ServerConfigService, ServerConfig>()(
  "@lumen/server/Config",
) {}

export const makeServerConfig = (
  overrides: Partial<ServerConfig> = {},
): Effect.Effect<ServerConfig, Error> =>
  Effect.try({
    try: () => ({ ...decodeConfig(process.env), ...overrides }),
    catch: (cause) => cause instanceof Error ? cause : new Error("Invalid configuration", { cause }),
  });

export const ServerConfigLive = (
  overrides: Partial<ServerConfig> = {},
): Layer.Layer<ServerConfigService, Error> =>
  Layer.effect(ServerConfigService, makeServerConfig(overrides));
