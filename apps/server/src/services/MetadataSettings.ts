import { Database, metadataProviderSettings } from "@lumen/database";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

export interface MetadataSettingsShape {
  readonly tmdbKey: () => Effect.Effect<string | null, unknown>;
  readonly setTmdbKey: (key: string | null, nowMs: number) => Effect.Effect<void, unknown>;
}

export const makeMetadataSettings = Effect.gen(function* () {
  const database = yield* Database;
  const tmdbKey: MetadataSettingsShape["tmdbKey"] = () =>
    database
      .select({
        apiKey: metadataProviderSettings.apiKey,
      })
      .from(metadataProviderSettings)
      .where(eq(metadataProviderSettings.provider, "tmdb"))
      .get()
      .pipe(Effect.map((row) => row?.apiKey ?? null));
  const setTmdbKey: MetadataSettingsShape["setTmdbKey"] = (key, nowMs) =>
    key === null
      ? database
          .delete(metadataProviderSettings)
          .where(eq(metadataProviderSettings.provider, "tmdb"))
          .pipe(
            Effect.asVoid,
            Effect.mapError(() => new Error("Could not clear metadata settings")),
          )
      : database
          .insert(metadataProviderSettings)
          .values({ provider: "tmdb", apiKey: key, updatedAtMs: nowMs })
          .onConflictDoUpdate({
            target: metadataProviderSettings.provider,
            set: { apiKey: key, updatedAtMs: nowMs },
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(() => new Error("Could not save metadata settings")),
          );
  return { tmdbKey, setTmdbKey };
});

export class MetadataSettings extends Context.Service<MetadataSettings, MetadataSettingsShape>()(
  "@lumen/server/MetadataSettings",
) {}
export const MetadataSettingsLive = Layer.effect(MetadataSettings, makeMetadataSettings);
