import { expect, test } from "bun:test";
import { collectAudioDiagnostics } from "../../apps/desktop/src/main/player/AudioDiagnostics";

test("audio diagnostics survive failed output initialization without reading private media properties", async () => {
  const privateProperties = new Set([
    "path",
    "stream-open-filename",
    "playlist",
    "track-list",
    "metadata",
  ]);
  const queried: string[] = [];
  const report = await collectAudioDiagnostics({
    command: async (args) => {
      const property = String(args[1]);
      queried.push(property);
      if (privateProperties.has(property)) throw new Error("Private property queried");
      if (property === "current-ao" || property === "audio-out-params")
        throw new Error("property unavailable");
      if (property === "audio-codec-name") return "dts";
      if (property === "audio-device-list")
        return [{ name: "auto", description: "Default device" }];
      return null;
    },
  });
  expect(report["current-ao"]).toBeNull();
  expect(report["audio-out-params"]).toBeNull();
  expect(report["audio-codec-name"]).toBe("dts");
  expect(report["audio-device-list"]).toEqual([{ name: "auto", description: "Default device" }]);
  expect(queried.some((property) => privateProperties.has(property))).toBe(false);
});

test("pitch/filter diagnostics expose only bounded safe scaletempo2 metrics", async () => {
  const report = await collectAudioDiagnostics({ command: async (args) => {
    switch (args[1]) {
      case "speed": return 0.99;
      case "audio-pitch-correction": return true;
      case "af": return [
        { name: "scaletempo2", enabled: true, label: "/private/path", params: { "search-interval": "40", "window-size": "12", url: "https://private/?token=secret" } },
        { name: "lavfi", label: "secret", params: { graph: "amovie=/private/file" } },
      ];
      default: return null;
    }
  } });
  expect(report.speed).toBe(0.99);
  expect(report["audio-pitch-correction"]).toBe(true);
  expect(report.af).toEqual([
    { name: "scaletempo2", enabled: true, params: { "search-interval": 40, "window-size": 12 } },
    { name: "other", enabled: false, params: {} },
  ]);
  expect(JSON.stringify(report)).not.toContain("private");
  expect(JSON.stringify(report)).not.toContain("secret");
});
