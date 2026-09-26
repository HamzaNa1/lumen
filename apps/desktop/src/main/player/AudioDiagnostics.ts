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
] as const;

export async function collectAudioDiagnostics(
  ipc: Pick<MpvIpc, "command">,
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    properties.map(async (property) => {
      try {
        return [property, await ipc.command(["get_property", property])] as const;
      } catch {
        return [property, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
