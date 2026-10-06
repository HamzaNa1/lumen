import { Schema } from "effect";
import type { PlayableStream } from "./models.ts";

export const TrackLanguage = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{4})?(?:-(?:[a-zA-Z]{2}|[0-9]{3}))?$/),
  Schema.isMaxLength(35),
);
export const TrackPreferences = Schema.Struct({
  audioLanguage: TrackLanguage,
  subtitleLanguage: Schema.NullOr(TrackLanguage),
});
export type TrackPreferences = Schema.Schema.Type<typeof TrackPreferences>;
export const TrackPreferencesPatch = Schema.Struct({
  audioLanguage: Schema.optional(TrackLanguage),
  subtitleLanguage: Schema.optional(Schema.NullOr(TrackLanguage)),
});
export type TrackPreferencesPatch = Schema.Schema.Type<typeof TrackPreferencesPatch>;
export const TrackKind = Schema.Literals(["audio", "subtitle"]);
export type TrackKind = Schema.Schema.Type<typeof TrackKind>;
export const SavedTrack = Schema.Struct({
  sourceId: Schema.String,
  streamId: Schema.String,
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  codec: Schema.NullOr(Schema.String),
  channels: Schema.NullOr(Schema.Number),
  commentary: Schema.NullOr(Schema.Boolean),
  forced: Schema.NullOr(Schema.Boolean),
  hearingImpaired: Schema.NullOr(Schema.Boolean),
});
export type SavedTrack = Schema.Schema.Type<typeof SavedTrack>;
export const SubtitleChoice = Schema.Union([SavedTrack, Schema.Literal("off")]);
export const TrackMemory = Schema.Struct({
  preferences: TrackPreferences,
  audio: Schema.NullOr(SavedTrack),
  subtitle: Schema.NullOr(SubtitleChoice),
});
export type TrackMemory = Schema.Schema.Type<typeof TrackMemory>;
export const TrackChoiceInput = Schema.Struct({
  kind: TrackKind,
  // null inherits settings; "off" is an explicit subtitle override.
  choice: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
});
export type TrackChoiceInput = Schema.Schema.Type<typeof TrackChoiceInput>;
export const DEFAULT_TRACK_PREFERENCES: TrackPreferences = {
  audioLanguage: "en",
  subtitleLanguage: null,
};
export const defaultTrackMemory = (): TrackMemory => ({
  preferences: DEFAULT_TRACK_PREFERENCES,
  audio: null,
  subtitle: null,
});

const languageAliases: Readonly<Record<string, string>> = {
  fre: "fr",
  ger: "de",
  chi: "zh",
  dut: "nl",
  cze: "cs",
  gre: "el",
  per: "fa",
  rum: "ro",
  may: "ms",
  slo: "sk",
  baq: "eu",
  ice: "is",
  alb: "sq",
  arm: "hy",
  bur: "my",
  geo: "ka",
  mac: "mk",
  mao: "mi",
  tib: "bo",
  wel: "cy",
};
export const normalizeTrackLanguage = (value: string | null | undefined): string | null => {
  const code = value?.trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  if (!code || ["und", "unk", "unknown", "zxx"].includes(code)) return null;
  const alias = languageAliases[code] ?? code;
  try {
    return new Intl.Locale(alias).language;
  } catch {
    return null;
  }
};
const normalizedText = (value: string | null | undefined): string | null =>
  value?.trim().toLowerCase().replace(/\s+/g, " ") || null;

export const describeTrack = (sourceId: string, stream: PlayableStream): SavedTrack => ({
  sourceId,
  streamId: stream.id,
  language: normalizeTrackLanguage(stream.language),
  title: normalizedText(stream.title),
  codec: normalizedText(stream.codec),
  channels: stream.channels ?? null,
  commentary: stream.commentary ?? null,
  forced: stream.forced ?? null,
  hearingImpaired: stream.hearingImpaired ?? null,
});

const matchOverride = (
  streams: ReadonlyArray<PlayableStream>,
  sourceId: string,
  saved: SavedTrack,
): PlayableStream | undefined => {
  if (saved.sourceId === sourceId) {
    const exact = streams.find((stream) => stream.id === saved.streamId);
    if (exact !== undefined) {
      const descriptor = describeTrack(sourceId, exact);
      const fields = [
        "language",
        "title",
        "codec",
        "channels",
        "commentary",
        "forced",
        "hearingImpaired",
      ] as const;
      if (fields.every((field) => saved[field] === null || saved[field] === descriptor[field]))
        return exact;
    }
  }
  // Legacy scans have unknown roles. Neither a missing language nor unknown roles establishes
  // semantic identity across files, even when there happens to be just one candidate.
  if (
    saved.language === null ||
    saved.commentary === null ||
    saved.forced === null ||
    saved.hearingImpaired === null
  )
    return undefined;
  const candidates = streams.filter((stream) => {
    const descriptor = describeTrack(sourceId, stream);
    return (
      descriptor.language === saved.language &&
      descriptor.title === saved.title &&
      descriptor.commentary === saved.commentary &&
      descriptor.forced === saved.forced &&
      descriptor.hearingImpaired === saved.hearingImpaired
    );
  });
  if (candidates.length === 1) return candidates[0];
  const distinguished = candidates.filter(
    (stream) =>
      (saved.codec === null || normalizedText(stream.codec) === saved.codec) &&
      (saved.channels === null || stream.channels === saved.channels),
  );
  return distinguished.length === 1 ? distinguished[0] : undefined;
};

export const resolveTrackSelection = (
  streams: ReadonlyArray<PlayableStream>,
  sourceId: string,
  memory: TrackMemory = defaultTrackMemory(),
): { audio: PlayableStream | null; subtitle: PlayableStream | null } => {
  const ordered = [...streams].sort((a, b) => a.ordinal - b.ordinal);
  const audio = ordered.filter((stream) => stream.kind === "audio");
  const subtitles = ordered.filter((stream) => stream.kind === "subtitle");
  const byLanguage = (tracks: ReadonlyArray<PlayableStream>, language: string | null) => {
    const normalized = normalizeTrackLanguage(language);
    return normalized === null
      ? undefined
      : tracks.find((track) => normalizeTrackLanguage(track.language) === normalized);
  };
  return {
    audio:
      (memory.audio === null ? undefined : matchOverride(audio, sourceId, memory.audio)) ??
      byLanguage(audio, memory.preferences.audioLanguage) ??
      audio[0] ??
      null,
    subtitle:
      memory.subtitle === "off"
        ? null
        : ((memory.subtitle === null
            ? undefined
            : matchOverride(subtitles, sourceId, memory.subtitle)) ??
          byLanguage(subtitles, memory.preferences.subtitleLanguage) ??
          null),
  };
};
