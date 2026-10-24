import type { ElectronApplication } from "@playwright/test";

interface Wire {
  arm(mode: "hold-speed" | "fail-speed" | "hold-sample"): void;
  snapshot(): {
    captured: (string | number)[] | null;
    commands: { command: (string | number)[]; outcome: string }[];
  };
  release(): void;
  command(args: (string | number)[]): Promise<unknown>;
}
type MainGlobal = typeof globalThis & { __lumenMpvWire: Wire };
export const mpvWire = (app: ElectronApplication) => ({
  arm: (mode: Parameters<Wire["arm"]>[0]) =>
    app.evaluate((_electron, mode) => (globalThis as MainGlobal).__lumenMpvWire.arm(mode), mode),
  snapshot: () => app.evaluate(() => (globalThis as MainGlobal).__lumenMpvWire.snapshot()),
  release: () => app.evaluate(() => (globalThis as MainGlobal).__lumenMpvWire.release()),
  command: (args: (string | number)[]) =>
    app.evaluate(
      (_electron, args) => (globalThis as MainGlobal).__lumenMpvWire.command(args),
      args,
    ),
});
