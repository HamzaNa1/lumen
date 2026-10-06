import { expect, test } from "bun:test";
import { analyzeAudioTransition } from "../helpers/audio-transition";

const RATE = 48000;
const FRAME_BYTES = 6 * 4;
const COMMAND_MS = 250;
const CAPTURE_START = (((COMMAND_MS - 100) * RATE) / 1000) * FRAME_BYTES;
const OLD_CAPTURE_START = (((COMMAND_MS + 450) * RATE) / 1000) * FRAME_BYTES;

const tone = (artifact: "none" | "pitch" | "dropout"): Buffer => {
  const audio = Buffer.alloc(RATE * FRAME_BYTES);
  let phase = 0;
  for (let frame = 0; frame < RATE; frame++) {
    const ms = (frame * 1000) / RATE;
    const frequency = artifact === "pitch" && ms >= COMMAND_MS && ms < COMMAND_MS + 20 ? 420 : 440;
    phase += (2 * Math.PI * frequency) / RATE;
    for (let channel = 0; channel < 6; channel++) {
      const muted =
        artifact === "dropout" && channel === 2 && ms >= COMMAND_MS && ms < COMMAND_MS + 5;
      audio.writeFloatLE(muted ? 0 : 0.15 * Math.sin(phase), frame * FRAME_BYTES + channel * 4);
    }
  }
  return audio;
};

test("overlapping pitch and energy windows cover the complete pre/post-command capture", () => {
  const audio = tone("none");
  const report = analyzeAudioTransition(audio, CAPTURE_START, audio.length);
  expect(report.pitchWindowMs).toBe(50);
  expect(report.pitchHopMs).toBe(10);
  expect(report.energyWindowMs).toBe(10);
  expect(report.energyHopMs).toBe(5);
  expect(report.pitch[0]?.offsetMs).toBe(0);
  expect(report.pitch.at(-1)?.offsetMs).toBe(800);
  expect(report.energy.at(-1)?.offsetMs).toBe(840);
  // This window starts before the speed command and ends after it.
  expect(report.pitch.some((window) => window.offsetMs < 100 && window.offsetMs + 50 > 100)).toBe(
    true,
  );
});

test("a 20 ms pitch dip at the speed command is caught instead of hidden by the old 450 ms wait", () => {
  const audio = tone("pitch");
  expect(() => analyzeAudioTransition(audio, OLD_CAPTURE_START, audio.length)).not.toThrow();
  expect(() => analyzeAudioTransition(audio, CAPTURE_START, audio.length)).toThrow("Pitch changed");
});

test("a 5 ms center-channel dropout at the speed command is caught instead of hidden by the old wait", () => {
  const audio = tone("dropout");
  expect(() => analyzeAudioTransition(audio, OLD_CAPTURE_START, audio.length)).not.toThrow();
  expect(() => analyzeAudioTransition(audio, CAPTURE_START, audio.length)).toThrow(
    "Center-channel dropout",
  );
});
