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
  arm(mode: "hold-speed" | "fail-speed" | "hold-sample", speed?: number): number;
  snapshot(): { captured: WireEntry | null; commands: WireEntry[]; expired: number[] };
  release(): void;
  command(args: (string | number)[]): Promise<unknown>;
}
type MainGlobal = typeof globalThis & { __lumenMpvWire: Wire };
export const mpvWire = (app: ElectronApplication) => ({
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
        const offset = expectedSpeed < 1 ? 0.5 : -0.5;
        // Advance the supplied group clock across the IPC/probe latency before seeking.
        await wire.command([
          "seek",
          targetSeconds + (Date.now() - atMs) / 1000 + offset,
          "absolute+exact",
        ]);
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
