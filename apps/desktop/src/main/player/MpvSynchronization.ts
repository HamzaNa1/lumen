import type { WatchPlaybackSample, WatchPlayerState } from "@lumen/client";
import type { MpvIpc } from "./MpvIpc";

// Raw property expansion reads position and all motion flags in a single MPV command.
const SAMPLE_TEXT = ["time-pos", "pause", "paused-for-cache", "seeking", "eof-reached", "speed"]
  .map((property) => `\${=${property}}`)
  .join("\t");

export async function sampleMpvPlayback(
  ipc: Pick<MpvIpc, "command">,
  state: WatchPlayerState,
): Promise<WatchPlaybackSample | null> {
  const beforeMs = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const value = await Promise.race([
    ipc.command(["expand-text", SAMPLE_TEXT]),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 100);
    }),
  ]).finally(() => clearTimeout(timer));
  const afterMs = performance.now();
  // The measurement occurred somewhere within this round trip. Under load, skip an uncertain
  // sample rather than treating command latency as drift. This does not reuse a cached sample.
  if (afterMs - beforeMs > 100 || typeof value !== "string") return null;
  const fields = value.split("\t");
  if (fields.length !== 6) return null;
  const [position, pause, cache, seeking, ended, rate] = fields;
  if (
    !position ||
    !rate ||
    ![pause, cache, seeking, ended].every((flag) => flag === "yes" || flag === "no")
  )
    return null;
  const positionSeconds = Number(position);
  const speed = Number(rate);
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0 || !Number.isFinite(speed))
    return null;
  return {
    ...state,
    positionSeconds,
    speed,
    paused: pause === "yes",
    advancing: pause === "no" && cache === "no" && seeking === "no" && ended === "no",
    sampledAtMs: (beforeMs + afterMs) / 2,
  };
}

// One persistent instance receives MPV's speed command, so its automatic filter stays idle.
// Keep the upstream WSOLA defaults; tuning them has no demonstrated benefit for +/-1% sync.
export const mpvPitchArguments = [
  "--audio-pitch-correction=yes",
  "--af=@lumen-tempo:scaletempo2",
] as const;
