import { DEFAULT_TRANSCODING_SETTINGS, TranscodingSettings } from "@lumen/contracts";
import { Database, transcodingSettings } from "@lumen/database";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

export interface TranscodingSettingsShape {
  readonly read: () => Effect.Effect<TranscodingSettings, unknown>;
  readonly save: (settings: TranscodingSettings) => Effect.Effect<void, unknown>;
}
export class TranscodingSettingsService extends Context.Service<
  TranscodingSettingsService,
  TranscodingSettingsShape
>()("@lumen/server/TranscodingSettings") {}
export const TranscodingSettingsLive = Layer.effect(
  TranscodingSettingsService,
  Effect.gen(function* () {
    const database = yield* Database;
    const read: TranscodingSettingsShape["read"] = () =>
      database
        .select()
        .from(transcodingSettings)
        .where(eq(transcodingSettings.id, 1))
        .get()
        .pipe(
          Effect.map((row) =>
            row === undefined
              ? DEFAULT_TRANSCODING_SETTINGS
              : Schema.decodeUnknownSync(TranscodingSettings)(JSON.parse(row.settings)),
          ),
        );
    const save: TranscodingSettingsShape["save"] = (settings) =>
      database
        .insert(transcodingSettings)
        .values({ id: 1, settings: JSON.stringify(settings) })
        .onConflictDoUpdate({
          target: transcodingSettings.id,
          set: { settings: JSON.stringify(settings) },
        })
        .pipe(Effect.asVoid);
    return { read, save };
  }),
);
