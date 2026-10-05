import type { MpvIpc } from "./MpvIpc";

// Other properties can contain filenames, server URLs, or stream capabilities.
// Only query the audio properties needed to diagnose device/decoder failures.
const properties = [
  "mpv-version",
  "ffmpeg-version",
  "aid",
  "audio-codec-name",
  "audio-decoder",
  "audio-params",
  "audio-out-params",
  "audio-channels",
  "audio-device",
  "audio-device-list",
  "current-ao",
  "audio-exclusive",
  "audio-spdif",
  "volume",
  "mute",
  "pause",
  "speed",
  "audio-speed-correction",
  "audio-pitch-correction",
  "af",
] as const;

const safeFilters = (value: unknown): unknown =>
  !Array.isArray(value)
    ? null
    : value.slice(0, 16).map((entry: unknown) => {
        if (entry === null || typeof entry !== "object") return { name: "unknown" };
        const filter = entry as { name?: unknown; enabled?: unknown; params?: unknown };
        const params =
          filter.params !== null && typeof filter.params === "object"
            ? (filter.params as Record<string, unknown>)
            : {};
        return {
          name: filter.name === "scaletempo2" ? "scaletempo2" : "other",
          enabled: filter.enabled === true,
          params:
            filter.name !== "scaletempo2"
              ? {}
              : Object.fromEntries(
                  ["min-speed", "max-speed", "search-interval", "window-size"].flatMap((key) => {
                    const value = params[key];
                    const number =
                      typeof value === "string" && value.trim() !== "" ? Number(value) : value;
                    return typeof number === "number" && Number.isFinite(number)
                      ? [[key, number]]
                      : [];
                  }),
                ),
        };
      });

export async function collectAudioDiagnostics(
  ipc: Pick<MpvIpc, "command">,
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    properties.map(async (property) => {
      try {
        const value = await ipc.command(["get_property", property]);
        return [property, property === "af" ? safeFilters(value) : value] as const;
      } catch {
        return [property, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
