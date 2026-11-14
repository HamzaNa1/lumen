import type { ElectronApplication } from "@playwright/test";

export interface WireEntry {
  id: number;
  connection: number;
  requestId: number;
  command: (string | number)[];
  outcome: string;
  sentAtMs: number;
  repliedAtMs: number | null;
  error: string | null;
  sample: string | null;
  heldAtMs: number | null;
  releasedAtMs: number | null;
}
interface Wire {
  crash(): Promise<void>;
  restrictDecoders(value: { video?: string; audio?: string }): void;
  arm(
    mode: "hold-speed" | "fail-speed" | "hold-sample" | "hold-unpause" | "hold-stop",
    speed?: number,
  ): number;
  snapshot(): {
    captured: WireEntry | null;
    commands: WireEntry[];
    expired: number[];
    closed: number[];
  };
  /** Resolves on MPV's next playback-restart event, which ends a seek. */
  restarted(): Promise<void>;
  release(): void;
  command(args: (string | number)[]): Promise<unknown>;
}
type MainGlobal = typeof globalThis & { __lumenMpvWire: Wire };
export const mpvWire = (app: ElectronApplication) => ({
  crash: () => app.evaluate(() => (globalThis as MainGlobal).__lumenMpvWire.crash()),
  restrictDecoders: (value: { video?: string; audio?: string }) =>
    app.evaluate(
      (_electron, value) => (globalThis as MainGlobal).__lumenMpvWire.restrictDecoders(value),
      value,
    ),
  arm: (mode: Parameters<Wire["arm"]>[0]) =>
    app.evaluate((_electron, mode) => (globalThis as MainGlobal).__lumenMpvWire.arm(mode), mode),
  disturb: (mode: "hold-speed" | "fail-speed", targetSeconds: number) =>
    app.evaluate(
      async (_electron, { mode, targetSeconds, atMs }) => {
        const wire = (globalThis as MainGlobal).__lumenMpvWire;
        const speed = await wire.command(["get_property", "speed"]);
        if (typeof speed !== "number") throw new Error("MPV did not report its speed");
        const expectedSpeed = speed < 1 ? 1.01 : 0.99;
        const afterId = wire.arm(mode, expectedSpeed);
        const groupPosition = () => targetSeconds + (Date.now() - atMs) / 1000;
        // Where MPV should sit relative to the group: inside the soft band, short of the seek threshold.
        const lead = expectedSpeed < 1 ? 0.5 : -0.5;
        // The group clock runs on while MPV decodes to an exact target, which can take over a
        // second on a loaded runner. Measure where each seek landed and aim the next past the shortfall.
        let compensation = 0;
        for (let seek = 0; seek < 3 && wire.snapshot().captured === null; seek++) {
          const restarted = wire.restarted();
          await wire.command(["seek", groupPosition() + lead + compensation, "absolute+exact"]);
          await restarted;
          const position = await wire.command(["get_property", "time-pos"]);
          if (typeof position !== "number") throw new Error("MPV did not report its position");
          const landed = position - groupPosition();
          if (
            Math.sign(landed) === Math.sign(lead) &&
            Math.abs(landed) >= 0.3 &&
            Math.abs(landed) < 0.8
          )
            break;
          compensation += lead - landed;
        }
        return { afterId, expectedSpeed };
      },
      { mode, targetSeconds, atMs: Date.now() },
    ),
  snapshot: () => app.evaluate(() => (globalThis as MainGlobal).__lumenMpvWire.snapshot()),
  release: () => app.evaluate(() => (globalThis as MainGlobal).__lumenMpvWire.release()),
  command: (args: (string | number)[]) =>
    app.evaluate(
      (_electron, args) => (globalThis as MainGlobal).__lumenMpvWire.command(args),
      args,
    ),
});
