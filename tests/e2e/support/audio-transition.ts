import assert from "node:assert/strict";

const SAMPLE_RATE = 48000;
const CHANNELS = 6;
const BYTES_PER_FRAME = CHANNELS * 4;
const TONE_CHANNELS = [0, 1, 2, 4, 5];
const PITCH_WINDOW_FRAMES = 2400;
const PITCH_HOP_FRAMES = 480;
const ENERGY_WINDOW_FRAMES = 480;
const ENERGY_HOP_FRAMES = 240;
// The fixture's 0.15-amplitude tone has mean-square energy 0.01125. Losing half of a
// 10 ms window falls below this two-thirds threshold, even with the sine's phase variation.
const MIN_CENTER_ENERGY = 0.15 ** 2 / 3;

/** Check every overlapping short window, including the PCM surrounding a speed command. */
export function analyzeAudioTransition(audio: Buffer, startByte: number, endByte: number) {
  const start = Math.ceil(startByte / BYTES_PER_FRAME);
  const end = Math.floor(endByte / BYTES_PER_FRAME);
  assert(start >= 0 && end * BYTES_PER_FRAME <= audio.length, "Invalid PCM capture bounds");
  assert(end - start >= PITCH_WINDOW_FRAMES, "Too little PCM for transition analysis");
  const sample = (frame: number, channel: number): number => {
    const value = audio.readFloatLE(frame * BYTES_PER_FRAME + channel * 4);
    assert(Number.isFinite(value), "Non-finite PCM sample");
    return value;
  };
  const windows = (size: number, hop: number): number[] => {
    const starts: number[] = [];
    for (let frame = start; frame + size <= end; frame += hop) starts.push(frame);
    // Include the tail even if it does not align with the hop, so no samples are skipped.
    if (starts.at(-1) !== end - size) starts.push(end - size);
    return starts;
  };
  const energy = windows(ENERGY_WINDOW_FRAMES, ENERGY_HOP_FRAMES).map((frame) => {
    let sum = 0;
    for (let i = frame; i < frame + ENERGY_WINDOW_FRAMES; i++) sum += sample(i, 2) ** 2;
    const meanSquare = sum / ENERGY_WINDOW_FRAMES;
    assert(
      meanSquare > MIN_CENTER_ENERGY,
      `Center-channel dropout at frame ${frame}: energy ${meanSquare}`,
    );
    return { offsetMs: ((frame - start) * 1000) / SAMPLE_RATE, meanSquare };
  });
  const pitch = windows(PITCH_WINDOW_FRAMES, PITCH_HOP_FRAMES).map((frame) => {
    const frequenciesHz = TONE_CHANNELS.map((channel) => {
      let firstCrossing: number | null = null;
      let lastCrossing = 0;
      let crossings = 0;
      for (let i = frame + 1; i < frame + PITCH_WINDOW_FRAMES; i++) {
        const previous = sample(i - 1, channel);
        const value = sample(i, channel);
        if (previous <= 0 && value > 0) {
          const crossing = i - 1 - previous / (value - previous);
          firstCrossing ??= crossing;
          lastCrossing = crossing;
          crossings++;
        }
      }
      assert(
        firstCrossing !== null && crossings > 10,
        `Missing channel ${channel} output at frame ${frame}`,
      );
      const frequency = ((crossings - 1) * SAMPLE_RATE) / (lastCrossing - firstCrossing);
      assert(
        Math.abs(frequency - 440) < 1.5,
        `Pitch changed in channel ${channel} at frame ${frame}: ${frequency} Hz`,
      );
      return frequency;
    });
    return { offsetMs: ((frame - start) * 1000) / SAMPLE_RATE, frequenciesHz };
  });
  return { pitchWindowMs: 50, pitchHopMs: 10, energyWindowMs: 10, energyHopMs: 5, pitch, energy };
}
