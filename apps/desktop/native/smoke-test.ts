// Runs the macOS helper against the real GPU and the production texture receiver.
// The parent integration suite must additionally import and capture these frames in Electron.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { decode, load } from "koffi";
import { MacTextureChannel } from "../src/main/player/MacTextureChannel";

const [helper] = process.argv.slice(2);
if (process.platform !== "darwin" || helper === undefined)
  throw new Error("Usage (macOS): bun smoke-test.ts <helper>");

const surfaces = load("/System/Library/Frameworks/IOSurface.framework/IOSurface");
const lock = surfaces.func("int IOSurfaceLock(void *, uint32_t, void *)");
const unlock = surfaces.func("int IOSurfaceUnlock(void *, uint32_t, void *)");
const baseAddress = surfaces.func("void *IOSurfaceGetBaseAddress(void *)");
const bytesPerRow = surfaces.func("size_t IOSurfaceGetBytesPerRow(void *)");

interface Frame {
  readonly type: string;
  readonly sequence: number;
  readonly handle: string;
  readonly width: number;
  readonly height: number;
  readonly message?: string;
}

const channel = new MacTextureChannel();
const child = spawn(
  helper,
  [
    `--lumen-parent-pid=${process.pid}`,
    `--lumen-port=${channel.name}`,
    "--lumen-width=320",
    "--lumen-height=180",
    "--lumen-test-pattern",
    "--no-config",
    "--load-scripts=no",
    "--idle=yes",
    "--no-terminal",
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

const read = async (): Promise<Frame> => {
  const next = await lines.next();
  if (next.done) throw new Error("Helper closed stdout");
  const message = JSON.parse(next.value) as Frame;
  if (message.type === "error") throw new Error(message.message);
  return message;
};

const pixel = (surface: bigint, x: number, y: number): string => {
  const offset = y * Number(bytesPerRow(surface)) + x * 4;
  const [blue, green, red] = decode(baseAddress(surface), offset, "uint8_t", 3) as number[];
  return [red, green, blue].map((value) => ((value ?? 0) > 127 ? 1 : 0)).join("");
};

const expectFrame = (frame: Frame, width: number, height: number): Frame => {
  if (
    frame.type !== "frame" ||
    frame.width !== width ||
    frame.height !== height ||
    frame.sequence <= 0 ||
    !/^[1-9][0-9]*$/.test(frame.handle)
  )
    throw new Error(`Invalid frame: ${JSON.stringify(frame)}`);
  channel.import(child.pid ?? 0, frame, (surface) => {
    if (lock(surface, 1, null) !== 0) throw new Error("Cannot read the shared texture");
    try {
      const corners = [
        pixel(surface, 1, 1),
        pixel(surface, width - 2, 1),
        pixel(surface, 1, height - 2),
        pixel(surface, width - 2, height - 2),
      ];
      // Red, green, blue and white from the top left: row 0 must be the top of the picture.
      if (corners.join(" ") !== "100 010 001 111")
        throw new Error(`Test pattern is misoriented: ${corners.join(" ")}`);
    } finally {
      unlock(surface, 1, null);
    }
  });
  return frame;
};

try {
  if ((await read()).type !== "ready") throw new Error("Missing ready");
  const first = expectFrame(await read(), 320, 180);
  child.stdin.write("resize 640 360\n");
  expectFrame(await read(), 640, 360);
  child.stdin.write("resize 800 450\n");
  const third = expectFrame(await read(), 800, 450);
  child.stdin.write("resize 960 540\n");
  const pending = read();
  const early = await Promise.race([
    pending.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  if (early) throw new Error("Published a fourth occupied texture");
  child.stdin.write(`release ${first.sequence}\n`);
  const fourth = expectFrame(await pending, 960, 540);
  if (fourth.sequence <= third.sequence) throw new Error("Non-monotonic sequence");
  child.stdin.write(`release ${first.sequence}\n`);
  const failure = JSON.parse((await lines.next()).value ?? "{}") as Frame;
  if (failure.type !== "error") throw new Error("Duplicate release accepted");
  const code = await Promise.race([
    exited,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  if (code === "timeout") throw new Error("Shutdown exceeded deadline");
  if (code === 0) throw new Error("Malformed protocol exited successfully");
  console.log(
    "Three-slot transport, orientation, resize, sequence, duplicate-release and shutdown checks passed",
  );
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  channel.dispose();
}
process.exit(0);
