import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Nominal RGB code values, encoded as limited-range BT.709 video. Each stripe is 64 pixels wide.
const colors = [
  [0, 0, 0],
  [32, 32, 32],
  [64, 64, 64],
  [128, 128, 128],
  [192, 192, 192],
  [255, 255, 255],
  [160, 80, 64],
  [64, 144, 96],
  [64, 96, 160],
  [192, 144, 112],
];
const pixels = Buffer.alloc(640 * 360 * 3);
for (let y = 0; y < 360; y++)
  for (let x = 0; x < 640; x++) pixels.set(colors[Math.floor(x / 64)] ?? [], (y * 640 + x) * 3);
execFileSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-y",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    "640x360",
    "-framerate",
    "24",
    "-i",
    "pipe:0",
    "-vf",
    "loop=loop=239:size=1:start=0,scale=in_range=full:out_range=limited:out_color_matrix=bt709",
    "-c:v",
    "libx264",
    "-crf",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-color_range",
    "tv",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    join(import.meta.dirname, "../tests/fixtures/sdr-colors.mp4"),
  ],
  { input: pixels, stdio: ["pipe", "inherit", "inherit"] },
);
