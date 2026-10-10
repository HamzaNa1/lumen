import { expect, test } from "bun:test";
import { episodesOfShow, showOfEpisode } from "../../packages/app/src/ShowEpisodes.ts";

interface Node {
  readonly id: string;
  readonly kind: string;
  readonly parentId: string | null;
  readonly title: string;
}

/** A catalog over a fixed tree, serving children two to a page as the server pages them. */
const catalogOf = (nodes: ReadonlyArray<Node>) => {
  const requests: string[] = [];
  const catalog = {
    itemDetails: async (itemId: string) => {
      const item = nodes.find((node) => node.id === itemId);
      if (item === undefined) throw new Error(`Unknown item ${itemId}`);
      return { item };
    },
    itemChildren: async (parentId: string, cursor?: string | null) => {
      requests.push(`${parentId}@${cursor ?? "start"}`);
      const children = nodes.filter((node) => node.parentId === parentId);
      const start = cursor == null ? 0 : Number(cursor);
      return {
        items: children.slice(start, start + 2),
        nextCursor: start + 2 < children.length ? String(start + 2) : null,
      };
    },
  };
  return { catalog: catalog as never, requests };
};

const show = { id: "show", kind: "show", parentId: null, title: "House" };
const season1 = { id: "s1", kind: "season", parentId: "show", title: "Season 1" };
const season2 = { id: "s2", kind: "season", parentId: "show", title: "Season 2" };
const episode = (id: string, parentId: string): Node => ({ id, kind: "episode", parentId, title: id });

test("an episode's show is found through its season, or directly above it", async () => {
  const { catalog } = catalogOf([show, season1, episode("e1", "s1"), episode("special", "show")]);
  expect(await showOfEpisode(catalog, "e1")).toEqual({ id: "show", title: "House" });
  expect(await showOfEpisode(catalog, "special")).toEqual({ id: "show", title: "House" });
});

test("a film, and an episode filed under no show, belong to no show", async () => {
  const { catalog } = catalogOf([
    { id: "film", kind: "movie", parentId: null, title: "Film" },
    { id: "orphan", kind: "episode", parentId: null, title: "Orphan" },
    // Deeper than any show keeps its episodes.
    { id: "folder", kind: "season", parentId: "s1", title: "Folder" },
    show,
    season1,
    episode("buried", "folder"),
  ]);
  expect(await showOfEpisode(catalog, "film")).toBeNull();
  expect(await showOfEpisode(catalog, "orphan")).toBeNull();
  expect(await showOfEpisode(catalog, "buried")).toBeNull();
});

test("a show's episodes are gathered season by season across every page", async () => {
  const { catalog, requests } = catalogOf([
    show,
    season1,
    season2,
    episode("special", "show"),
    episode("e1", "s1"),
    episode("e2", "s1"),
    episode("e3", "s1"),
    episode("e4", "s2"),
  ]);
  const groups = await episodesOfShow(catalog, "show");
  expect(
    groups.map((group) => [group.season?.id ?? null, group.episodes.map((item) => item.id)]),
  ).toEqual([
    ["s1", ["e1", "e2", "e3"]],
    ["s2", ["e4"]],
    [null, ["special"]],
  ]);
  expect(requests).toContain("s1@2");
});

test("a season without episodes is left out", async () => {
  const { catalog } = catalogOf([show, season1, season2, episode("e1", "s2")]);
  expect((await episodesOfShow(catalog, "show")).map((group) => group.season?.id)).toEqual(["s2"]);
});
