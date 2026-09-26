import { Schema } from "effect";
import { IpcItem, IpcLibrary } from "./ipc";
import { Uuid } from "./schemas/common";

export const HomeContent = Schema.Struct({
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
