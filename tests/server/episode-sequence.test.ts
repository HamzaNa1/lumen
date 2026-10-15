import { expect, test } from "bun:test";
import {
  firstUnwatchedEpisode,
  nextEpisode,
  previousEpisode,
} from "../../apps/server/src/services/EpisodeSequence";

const entry = (
  id: string,
  seasonNumber: number | null,
  indexNumber: number | null,
  indexNumberEnd: number | null = null,
  completed = false,
) => ({ id, seasonNumber, indexNumber, indexNumberEnd, completed });

test("single episodes keep plain list order in both directions", () => {
  const list = [entry("s1e1", 1, 1), entry("s1e2", 1, 2), entry("s2e1", 2, 1)];
  expect(nextEpisode(list, 0)?.id).toBe("s1e2");
  expect(nextEpisode(list, 1)?.id).toBe("s2e1");
  expect(nextEpisode(list, 2)).toBeNull();
  expect(previousEpisode(list, 2)?.id).toBe("s1e2");
  expect(previousEpisode(list, 0)).toBeNull();
  expect(nextEpisode(list, -1)).toBeNull();
});

test("a combined file is followed by the episode after its last, even into the next season", () => {
  const list = [
    entry("e10", 3, 10),
    entry("e10-11", 3, 10, 11),
    entry("e11", 3, 11),
    entry("s4e1", 4, 1),
  ];
  expect(nextEpisode(list, 1)?.id).toBe("s4e1");
  expect(previousEpisode(list, 1)).toBeNull();
  expect(nextEpisode(list, 0)?.id).toBe("e10-11");
});

test("entries without a known number are never skipped", () => {
  const list = [entry("e1-2", 1, 1, 2), entry("extra", 1, null), entry("e2", 1, 2)];
  expect(nextEpisode(list, 0)?.id).toBe("extra");
  expect(firstUnwatchedEpisode([entry("e1-2", 1, 1, 2, true), entry("extra", 1, null)])?.id).toBe(
    "extra",
  );
});

test("the first unwatched entry skips episodes a finished combined file covered", () => {
  const list = [
    entry("e10-11", 3, 10, 11, true),
    entry("e11", 3, 11),
    entry("e11-12", 3, 11, 12),
    entry("s4e11", 4, 11),
  ];
  expect(firstUnwatchedEpisode(list)?.id).toBe("e11-12");
  expect(firstUnwatchedEpisode(list.filter((item) => item.id !== "e11-12"))?.id).toBe("s4e11");
  expect(firstUnwatchedEpisode([entry("done", 1, 1, null, true)])).toBeNull();
});
