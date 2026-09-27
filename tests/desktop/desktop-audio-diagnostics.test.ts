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
