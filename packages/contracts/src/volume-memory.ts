import { Schema } from "effect";
import { VolumeSettings } from "./models.ts";

/** How many titles keep their own volume; the ones set longest ago are forgotten first. */
export const MAX_REMEMBERED_TITLE_VOLUMES = 500;

export const TitleVolume = Schema.Struct({
  titleId: Schema.String.check(Schema.isMinLength(1)),
  ...VolumeSettings.fields,
});
export type TitleVolume = Schema.Schema.Type<typeof TitleVolume>;

/**
 * The volume a client keeps for each show or movie, so every episode of a show plays as loud as
 * the viewer last left any of them. The top-level volume is the one they chose most recently,
 * which is where a title they have never adjusted starts.
 */
export const VolumeMemory = Schema.Struct({
  ...VolumeSettings.fields,
  /** Most recently set first. Absent in what clients kept before volume followed the title. */
  titleVolumes: Schema.optional(Schema.Array(TitleVolume)),
});
export type VolumeMemory = Schema.Schema.Type<typeof VolumeMemory>;

/** The volume a title plays at. Without a title, the most recently chosen volume. */
export const volumeForTitle = (memory: VolumeMemory, titleId: string | null): VolumeSettings => {
  const remembered =
    titleId === null
      ? undefined
      : memory.titleVolumes?.find((candidate) => candidate.titleId === titleId);
  const { volume, muted } = remembered ?? memory;
  return { volume, muted };
};

/** Keeps a volume the viewer chose for a title, and as where untouched titles start. */
export const rememberTitleVolume = (
  memory: VolumeMemory,
  titleId: string | null,
  settings: VolumeSettings,
): VolumeMemory => {
  const others = (memory.titleVolumes ?? []).filter((candidate) => candidate.titleId !== titleId);
  return {
    ...memory,
    volume: settings.volume,
    muted: settings.muted,
    titleVolumes:
      titleId === null
        ? others
        : [{ titleId, ...settings }, ...others].slice(0, MAX_REMEMBERED_TITLE_VOLUMES),
  };
};
