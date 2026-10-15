import { expect, test } from "bun:test";
import { parseVideoPath } from "../../apps/server/src/media/VideoPaths";

const episode = (file: string) => {
  const parsed = parseVideoPath("shows", `The Office (2005)/Season 3/${file}`);
  return [parsed.episodeNumber, parsed.episodeNumberEnd, parsed.warning];
};

test("a release named S03E10-11 is one entry covering episodes 10 and 11", () => {
  const parsed = parseVideoPath(
    "shows",
    "The Office (2005)/Season 3/The.Office.US.S03E10-11.1080p.AMZN.WEB.x264-MRSK.mkv",
  );
  expect(parsed).toMatchObject({
    kind: "episode",
    show: { path: "The Office (2005)", title: "The Office", year: 2005 },
    season: { path: "The Office (2005)/Season 3", number: 3 },
    episodeNumber: 10,
    episodeNumberEnd: 11,
    warning: null,
  });
});

test("dashed, prefixed and chained episode ranges are all recognised", () => {
  expect(episode("Show S03E10-E11.mkv")).toEqual([10, 11, null]);
  expect(episode("Show S03E10E11.mkv")).toEqual([10, 11, null]);
  expect(episode("show.s03e10-e11.mkv")).toEqual([10, 11, null]);
  // A dashed end is inclusive; a chain lists every episode.
  expect(episode("Show S03E10-E12.mkv")).toEqual([10, 12, null]);
  expect(episode("Show S03E10E11E12.mkv")).toEqual([10, 12, null]);
  expect(episode("Show S03E10-E11-E12.mkv")).toEqual([10, 12, null]);
});

test("a single episode keeps its old coordinates and title", () => {
  expect(parseVideoPath("shows", "House/Season 1/House S01E02 - Paternity.mkv")).toMatchObject({
    episodeNumber: 2,
    episodeNumberEnd: null,
    title: "Paternity",
    warning: null,
  });
  expect(episode("Show S03E10.mkv")).toEqual([10, null, null]);
});

test("resolutions, codecs and numeric titles after an episode are not ranges", () => {
  expect(episode("Show.S03E10-1080p.WEB.mkv")).toEqual([10, null, null]);
  expect(episode("Show.S03E10-720p.mkv")).toEqual([10, null, null]);
  expect(episode("Show S03E10 - 11 Monkeys.mkv")).toEqual([10, null, null]);
  expect(episode("Show.S03E10.x264-2160.mkv")).toEqual([10, null, null]);
  expect(parseVideoPath("shows", "Show/Season 3/Show S03E10 - 24 Hours.mkv").title).toBe("24 Hours");
});

test("reversed, repeated, gapped and implausibly long ranges fall back to the first episode", () => {
  expect(episode("Show S03E11-10.mkv")).toEqual([11, null, "episode_range_invalid"]);
  expect(episode("Show S03E10-E10.mkv")).toEqual([10, null, "episode_range_invalid"]);
  expect(episode("Show S03E10E12.mkv")).toEqual([10, null, "episode_range_invalid"]);
  expect(episode("Show S03E10E11E13.mkv")).toEqual([10, null, "episode_range_invalid"]);
  expect(episode("Show S03E01-E40.mkv")).toEqual([1, null, "episode_range_invalid"]);
  expect(episode("Show S03E01-E10.mkv")).toEqual([1, 10, null]);
});

test("movies never carry episode coordinates", () => {
  expect(parseVideoPath("movies", "Ocean's 11 (2001)/Ocean's 11 S01E01-02.mkv")).toMatchObject({
    kind: "movie",
    episodeNumber: null,
    episodeNumberEnd: null,
  });
});
