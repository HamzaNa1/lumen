import { Database, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";

export interface MetadataSettingsShape {
  readonly tmdbKey: () => Effect.Effect<string | null, unknown>;
  readonly setTmdbKey: (key: string | null, nowMs: number) => Effect.Effect<void, unknown>;
}

export const makeMetadataSettings = Effect.gen(function* () {
  const database = yield* Database;
  const tmdbKey: MetadataSettingsShape["tmdbKey"] = () => database.get<{ apiKey: string }>(sql`
    SELECT api_key AS apiKey FROM metadata_provider_settings WHERE provider = 'tmdb'
  `).pipe(Effect.map((row) => row?.apiKey ?? null));
  const setTmdbKey: MetadataSettingsShape["setTmdbKey"] = (key, nowMs) => key === null
    ? database.run(sql`DELETE FROM metadata_provider_settings WHERE provider = 'tmdb'`).pipe(Effect.asVoid, Effect.mapError(() => new Error("Could not clear metadata settings")))
    : database.run(sql`
        INSERT INTO metadata_provider_settings(provider, api_key, updated_at_ms) VALUES ('tmdb', ${key}, ${nowMs})
        ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at_ms = excluded.updated_at_ms
      `).pipe(Effect.asVoid, Effect.mapError(() => new Error("Could not save metadata settings")));
  return { tmdbKey, setTmdbKey };
});

export class MetadataSettings extends Context.Service<MetadataSettings, MetadataSettingsShape>()("@lumen/server/MetadataSettings") {}
export const MetadataSettingsLive = Layer.effect(MetadataSettings, makeMetadataSettings);
