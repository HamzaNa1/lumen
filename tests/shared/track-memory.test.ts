import { describe, expect, test } from "bun:test";
import {
  defaultTrackMemory,
  describeTrack,
  normalizeTrackLanguage,
  resolveTrackSelection,
  type PlayableStream,
  type TrackMemory,
} from "../../packages/contracts/src/index.ts";
import { TrackSelectionController } from "../../packages/client/src/index.ts";

const track = (id: string, patch: Partial<PlayableStream> = {}): PlayableStream => ({
  id,
  kind: "audio",
  ordinal: 1,
  language: "eng",
  title: null,
  codec: "aac",
  isDefault: false,
  channels: 2,
  commentary: false,
  forced: false,
  hearingImpaired: false,
  ...patch,
});
const choice = (stream: PlayableStream): TrackMemory => ({
  ...defaultTrackMemory(),
  [stream.kind]: describeTrack("original", stream),
});

describe("track matching policy", () => {
  test("defaults are English audio and Off; file order wins over default flags and commentary", () => {
    const streams = [
      track("later", { ordinal: 3, isDefault: true }),
      track("first", { title: "Commentary", commentary: true }),
    ];
    expect(resolveTrackSelection(streams, "file")).toMatchObject({
      audio: { id: "first" },
      subtitle: null,
    });
    const subs = [
      track("sub-later", { kind: "subtitle", ordinal: 4, isDefault: true }),
      track("sub-first", { kind: "subtitle", ordinal: 2, forced: true }),
    ];
    const memory = {
      ...defaultTrackMemory(),
      preferences: { audioLanguage: "en", subtitleLanguage: "en" },
    };
    expect(resolveTrackSelection([...streams, ...subs], "file", memory).subtitle?.id).toBe(
      "sub-first",
    );
  });
  test("aliases normalize; unknown or missing languages never count as English", () => {
    for (const value of ["EN", "eng", "en-US", "en_GB"])
      expect(normalizeTrackLanguage(value)).toBe("en");
    const streams = [
      track("unknown", { language: null }),
      track("french", { language: "fra", ordinal: 2 }),
    ];
    expect(resolveTrackSelection(streams, "file").audio?.id).toBe("unknown");
    expect(
      resolveTrackSelection(
        streams.map((s) => ({ ...s, kind: "subtitle" })),
        "file",
        {
          ...defaultTrackMemory(),
          preferences: { audioLanguage: "en", subtitleLanguage: "en" },
        },
      ).subtitle,
    ).toBeNull();
  });
  test("exact identity works with legacy metadata; regenerated IDs require known roles", () => {
    const legacy = track("old", {
      language: null,
      commentary: null,
      forced: null,
      hearingImpaired: null,
    });
    expect(
      resolveTrackSelection([legacy, track("fallback", { ordinal: 2 })], "original", choice(legacy))
        .audio?.id,
    ).toBe("old");
    expect(
      resolveTrackSelection(
        [{ ...legacy, id: "new" }, track("fallback", { ordinal: 2 })],
        "replacement",
        choice(legacy),
      ).audio?.id,
    ).toBe("fallback");
  });
  test("a primary ID reused by a rescan cannot override conflicting language or roles", () => {
    const selected = track("reused", { language: "ja", commentary: true, title: "Commentary" });
    const memory = choice(selected);
    const replacement = { ...selected, language: "fr", commentary: false, title: null };
    expect(
      resolveTrackSelection([replacement, track("preferred", { ordinal: 2 })], "original", memory)
        .audio?.id,
    ).toBe("preferred");
  });

  test("commentary follows metadata across reordered episodes, never an ordinal", () => {
    const commentary = track("old", { title: "Director Commentary", commentary: true, ordinal: 4 });
    const streams = [
      track("regular", { ordinal: 4 }),
      track("new", { title: "  director  commentary ", commentary: true, ordinal: 2 }),
    ] as const;
    expect(resolveTrackSelection(streams, "episode-2", choice(commentary)).audio?.id).toBe("new");
    expect(resolveTrackSelection([streams[0]], "episode-3", choice(commentary)).audio?.id).toBe(
      "regular",
    );
    expect(resolveTrackSelection(streams, "episode-4", choice(commentary)).audio?.id).toBe("new");
  });
  test("forced and hearing-impaired subtitles stay distinct; explicit Off wins over language", () => {
    const selected = track("selected", { kind: "subtitle", hearingImpaired: true });
    const streams = [
      track("forced", { kind: "subtitle", forced: true }),
      track("regular", { kind: "subtitle" }),
      { ...selected, id: "sdh" },
    ];
    expect(resolveTrackSelection(streams, "next", choice(selected)).subtitle?.id).toBe("sdh");
    expect(
      resolveTrackSelection(streams, "next", {
        ...choice(selected),
        subtitle: "off",
        preferences: { audioLanguage: "en", subtitleLanguage: "en" },
      }).subtitle,
    ).toBeNull();
  });
  test("codec and channels disambiguate, but indistinguishable candidates fall back", () => {
    const selected = track("chosen", { language: "ja", channels: 6, codec: "ac3" });
    const memory = choice(selected);
    const streams = [
      track("fallback"),
      track("stereo", { language: "jpn", channels: 2 }),
      { ...selected, id: "surround", ordinal: 8 },
    ];
    expect(resolveTrackSelection(streams, "next", memory).audio?.id).toBe("surround");
    expect(
      resolveTrackSelection(
        [...streams, { ...selected, id: "duplicate", ordinal: 9 }],
        "next",
        memory,
      ).audio?.id,
    ).toBe("fallback");
    expect(
      resolveTrackSelection(
        [track("fallback"), { ...selected, id: "unknown-role", commentary: null }],
        "next",
        memory,
      ).audio?.id,
    ).toBe("fallback");
  });
});

const controllerFixture = () => {
  const events: string[] = [];
  let memory = defaultTrackMemory();
  let active = true;
  let failure = false;
  let gate: Promise<void> | null = null;
  const controller = new TrackSelectionController({
    sourceId: "file",
    streams: [track("a"), track("b"), track("sub", { kind: "subtitle" })],
    assertActive: () => {
      if (!active) throw new Error("cancelled");
    },
    apply: async (kind, id) => {
      events.push(`apply ${kind} ${id}`);
    },
    save: async (input) => {
      events.push(`save ${input.kind} ${input.choice}`);
      const currentGate = gate;
      gate = null;
      if (currentGate !== null) await currentGate;
      if (failure) throw new Error("offline");
      memory = {
        ...memory,
        [input.kind]:
          input.choice === null
            ? null
            : input.choice === "off"
              ? "off"
              : describeTrack("file", track(input.choice, { kind: input.kind })),
      };
      return memory;
    },
    onError: (message) => events.push(message === null ? "saved" : "error"),
  });
  return {
    controller,
    events,
    memory: () => memory,
    fail: (value: boolean) => {
      failure = value;
    },
    gate: (value: Promise<void>) => {
      gate = value;
    },
    cancel: () => {
      active = false;
    },
  };
};

describe("explicit track selection queue", () => {
  test("automatic startup creates no override; rapid choices are applied and saved in order", async () => {
    const f = controllerFixture();
    expect(f.events).toEqual([]);
    const gate = Promise.withResolvers<void>();
    f.gate(gate.promise);
    const first = f.controller.select("audio", "a");
    const second = f.controller.select("audio", "b");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.events).toEqual(["apply audio a", "save audio a"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(f.memory().audio?.streamId).toBe("b");
    expect(f.events.filter((event) => event.startsWith("apply"))).toEqual([
      "apply audio a",
      "apply audio b",
    ]);
  });
  test("independent resets and explicit Off; reset immediately applies inherited selection", async () => {
    const f = controllerFixture();
    await f.controller.select("audio", "b");
    await f.controller.select("subtitle", null);
    await f.controller.reset("audio");
    expect(f.memory()).toMatchObject({ audio: null, subtitle: "off" });
    expect(f.events).toContain("apply audio a");
    await f.controller.reset("subtitle");
    expect(f.memory().subtitle).toBeNull();
    expect(f.events).toContain("apply subtitle null");
  });
  test("failed saves preserve playback and retry; a newer choice replaces the failed one", async () => {
    const f = controllerFixture();
    f.fail(true);
    await f.controller.select("audio", "a");
    expect(f.events).toContain("apply audio a");
    expect(f.events.at(-1)).toBe("error");
    await f.controller.select("audio", "b");
    f.fail(false);
    await f.controller.retry();
    expect(f.memory().audio?.streamId).toBe("b");
    expect(f.events.at(-1)).toBe("saved");
    expect(f.events.filter((event) => event.startsWith("save "))).toEqual([
      "save audio a",
      "save audio b",
      "save audio b",
    ]);
  });
  test("a failed reset applies settings immediately and retries clearing only that override", async () => {
    const f = controllerFixture();
    await f.controller.select("audio", "b");
    await f.controller.select("subtitle", null);
    f.fail(true);
    await f.controller.reset("audio");
    expect(f.events).toContain("apply audio a");
    expect(f.memory().audio?.streamId).toBe("b");
    f.fail(false);
    await f.controller.retry();
    expect(f.memory()).toMatchObject({ audio: null, subtitle: "off" });
  });

  test("cancelled playback prevents delayed responses and queued commands reaching another session", async () => {
    const f = controllerFixture();
    const gate = Promise.withResolvers<void>();
    f.gate(gate.promise);
    const first = f.controller.select("audio", "a");
    const second = f.controller.select("audio", "b");
    const firstFailure = first.catch((error: Error) => error.message);
    const secondFailure = second.catch((error: Error) => error.message);
    await Promise.resolve();
    await Promise.resolve();
    f.cancel();
    gate.resolve();
    expect(await firstFailure).toBe("cancelled");
    expect(await secondFailure).toBe("cancelled");
    expect(f.events).not.toContain("saved");
    expect(f.events).not.toContain("apply audio b");
  });
  test("unsuccessful selections never save", async () => {
    const f = controllerFixture();
    await expect(f.controller.select("audio", "missing")).rejects.toThrow("unavailable");
    expect(f.events).toEqual([]);
  });
});
