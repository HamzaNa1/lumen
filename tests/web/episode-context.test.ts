import { expect, test } from "bun:test";
import { episodeContext, episodeSubtitle, playingContext, runtimeOf } from "../../packages/app/src/format.ts";

test("an episode is placed in its show by a padded season and episode code", () => {
  expect(episodeContext({ seriesTitle: "House", seasonNumber: 1, indexNumber: 3 })).toBe(
    "House · S01E03",
  );
  expect(episodeContext({ seriesTitle: "House", seasonNumber: 12, indexNumber: 104 })).toBe(
    "House · S12E104",
  );
});

test("an episode context keeps only the parts that are known", () => {
  expect(episodeContext({ seriesTitle: "House", seasonNumber: null, indexNumber: 3 })).toBe(
    "House · E03",
  );
  expect(episodeContext({ seriesTitle: null, seasonNumber: 2, indexNumber: 1 })).toBe("S02E01");
  expect(episodeContext({})).toBe("");
});

test("the year an episode's season came out follows the name of its show", () => {
  const episode = { seriesTitle: "House", seasonNumber: 3, indexNumber: 1 };
  expect(episodeContext({ ...episode, seasonYear: 2006 })).toBe("House (2006) · S03E01");
  expect(episodeContext({ ...episode, seasonYear: null })).toBe("House · S03E01");
  expect(episodeContext({ ...episode, seriesTitle: null, seasonYear: 2006 })).toBe("S03E01");
});

test("the player dates an episode by its season and anything else by its own year", () => {
  const episode = { kind: "episode", seriesTitle: "House", seasonNumber: 3, indexNumber: 1 };
  expect(playingContext({ ...episode, year: 2007, seasonYear: 2006 })).toBe(
    "House (2006) · S03E01",
  );
  expect(playingContext({ kind: "movie", year: 2010 })).toBe("(2010)");
  expect(playingContext({ kind: "movie", year: null })).toBe("");
});

test("a runtime is given only when it comes to at least a minute", () => {
  expect(runtimeOf(null)).toBeNull();
  expect(runtimeOf(0)).toBeNull();
  expect(runtimeOf(20)).toBeNull();
  expect(runtimeOf(30)).toBe("1m");
  expect(runtimeOf(5_640)).toBe("1h 34m");
});

test("an episode too short to have a runtime is described by its code alone", () => {
  const episode = {
    id: "00000000-0000-4000-8000-000000000001",
    libraryId: "00000000-0000-4000-8000-000000000002",
    title: "Arrival",
    kind: "episode",
    year: null,
    artworkId: null,
    resumePositionSeconds: null,
    indexNumber: 1,
  };
  expect(episodeSubtitle({ ...episode, durationMs: 20_000 }, 1)).toBe("S1 E1");
  expect(episodeSubtitle({ ...episode, durationMs: 1_500_000 }, 1)).toBe("S1 E1 · 25m");
});
