import { Schema } from "effect";

/** A newer desktop release, and how far this installation has got with it. */
export const AppUpdate = Schema.Struct({
  version: Schema.String,
  phase: Schema.Literals(["available", "downloading", "ready"]),
  /** The share of the download received, from 0 to 1. */
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type AppUpdate = Schema.Schema.Type<typeof AppUpdate>;

export const AppUpdateStatus = Schema.Struct({
  /**
   * Whether new versions download in the background. Null where the app cannot install an update
   * itself, and a new version is downloaded from its release page instead.
   */
  automatic: Schema.NullOr(Schema.Boolean),
  update: Schema.NullOr(AppUpdate),
});
export type AppUpdateStatus = Schema.Schema.Type<typeof AppUpdateStatus>;
