import { expect, test } from "bun:test";
import { episodeContext, episodeSubtitle, runtimeOf } from "../../packages/app/src/format.ts";

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
