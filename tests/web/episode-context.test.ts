import { expect, test } from "bun:test";
import { episodeContext } from "../../packages/app/src/format.ts";

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
