import { describe, expect, test } from "bun:test";
import {
  MAX_REMEMBERED_TITLE_VOLUMES,
  rememberTitleVolume,
  type VolumeMemory,
  volumeForTitle,
} from "../../packages/contracts/src/index.ts";

const fresh: VolumeMemory = { volume: 100, muted: false };

describe("volume memory", () => {
  test("a title plays at its own volume, and untouched titles at the latest one chosen", () => {
    let memory = rememberTitleVolume(fresh, "show", { volume: 30, muted: false });
    memory = rememberTitleVolume(memory, "movie", { volume: 70, muted: true });
    expect(volumeForTitle(memory, "show")).toEqual({ volume: 30, muted: false });
    expect(volumeForTitle(memory, "movie")).toEqual({ volume: 70, muted: true });
    expect(volumeForTitle(memory, "never-played")).toEqual({ volume: 70, muted: true });
    expect(volumeForTitle(memory, null)).toEqual({ volume: 70, muted: true });
  });

  test("setting a title again replaces its volume rather than adding another", () => {
    let memory = rememberTitleVolume(fresh, "show", { volume: 30, muted: false });
    memory = rememberTitleVolume(memory, "movie", { volume: 70, muted: false });
    memory = rememberTitleVolume(memory, "show", { volume: 20, muted: false });
    expect(memory.titleVolumes).toEqual([
      { titleId: "show", volume: 20, muted: false },
      { titleId: "movie", volume: 70, muted: false },
    ]);
  });

  test("without a title only the latest volume changes", () => {
    const memory = rememberTitleVolume(
      rememberTitleVolume(fresh, "show", { volume: 30, muted: false }),
      null,
      { volume: 55, muted: false },
    );
    expect(memory).toEqual({
      volume: 55,
      muted: false,
      titleVolumes: [{ titleId: "show", volume: 30, muted: false }],
    });
  });

  test("the titles set longest ago are forgotten once too many are kept", () => {
    let memory = fresh;
    for (let index = 0; index <= MAX_REMEMBERED_TITLE_VOLUMES; index += 1)
      memory = rememberTitleVolume(memory, `title-${index}`, { volume: index % 101, muted: false });
    expect(memory.titleVolumes).toHaveLength(MAX_REMEMBERED_TITLE_VOLUMES);
    expect(memory.titleVolumes?.some((title) => title.titleId === "title-0")).toBe(false);
    expect(volumeForTitle(memory, "title-1")).toEqual({ volume: 1, muted: false });
  });
});
