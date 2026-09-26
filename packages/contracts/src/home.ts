import { Schema } from "effect";
import { IpcItem, IpcLibrary } from "./ipc";
import { Uuid } from "./schemas/common";

export const HomeSectionType = Schema.Literals([
  "libraries",
  "resume-video",
  "resume-audio",
  "next-up",
  "latest",
]);
export type HomeSectionType = Schema.Schema.Type<typeof HomeSectionType>;

const LibraryIds = Schema.Array(Uuid).check(Schema.isMaxLength(1000));
export const HomePreferences = Schema.Struct({
  sections: Schema.Array(HomeSectionType).check(
    Schema.isMaxLength(5),
    Schema.makeFilter((sections) => new Set(sections).size === sections.length),
  ),
  libraryOrder: LibraryIds,
  hiddenLibraries: LibraryIds,
  excludedLibraries: LibraryIds,
  hideWatched: Schema.Boolean,
  nextUpDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36500 })),
});
export type HomePreferences = Schema.Schema.Type<typeof HomePreferences>;

export const defaultHomePreferences: HomePreferences = {
  sections: ["libraries", "resume-video", "resume-audio", "next-up", "latest"],
  libraryOrder: [],
  hiddenLibraries: [],
  excludedLibraries: [],
  hideWatched: true,
  nextUpDays: 365,
};

export const HomeContent = Schema.Struct({
  preferences: HomePreferences,
  libraryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  libraries: Schema.Array(IpcLibrary),
  continueWatching: Schema.Array(IpcItem),
  continueListening: Schema.Array(IpcItem),
  nextUp: Schema.Array(IpcItem),
  latest: Schema.Array(
    Schema.Struct({
      libraryId: Uuid,
      libraryName: Schema.String,
      items: Schema.Array(IpcItem),
    }),
  ),
});
export type HomeContent = Schema.Schema.Type<typeof HomeContent>;
