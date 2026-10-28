import type { ChildProcess } from "node:child_process";

export interface HelperFrame {
  readonly sequence: number;
  readonly handle: string;
  readonly width: number;
  readonly height: number;
}

export const validateTextureSize = (width: number, height: number): void => {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 33554432
  )
    throw new Error("Unsupported video texture dimensions");
};

/** Owns the helper's bounded wire protocol. A lease is returned only by the GPU release callback. */
export class HelperFrames {
  private pending = "";
  private ready = false;
  private readonly initialization = Promise.withResolvers<void>();
  readonly initialized = this.initialization.promise;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private lastSequence = 0;
  private stopped = false;
  private readonly leases = new Map<number, ReturnType<typeof setTimeout>>();
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private size: { width: number; height: number } | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly frame: (frame: HelperFrame) => void,
    private readonly failure: (error: Error) => void,
  ) {
    void this.initialized.catch(() => undefined);
    this.startupTimer = setTimeout(
      () => this.fail(new Error("Video helper initialization timed out")),
      15000,
    );
    child.once("exit", () => this.fail(new Error("Video helper exited before initialization")));
    child.once("error", (cause) => this.fail(cause));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      try {
        this.pending += chunk.toString("utf8");
        if (this.pending.length > 16384) throw new Error("Video helper protocol overflow");
        let end = this.pending.indexOf("\n");
        while (end >= 0) {
          const line = this.pending.slice(0, end);
          this.pending = this.pending.slice(end + 1);
          this.receive(JSON.parse(line));
          end = this.pending.indexOf("\n");
        }
      } catch (cause) {
        this.fail(cause);
      }
    });
    child.stdin?.on("error", (cause) => this.fail(cause));
  }

  private receive(value: unknown): void {
    if (this.stopped) return;
    if (typeof value !== "object" || value === null) throw new Error("Invalid helper message");
    const message = value as Partial<HelperFrame> & { type?: string; message?: string };
    if (message.type === "error")
      throw new Error(`Video helper: ${String(message.message).slice(0, 1024)}`);
    if (message.type === "ready" && !this.ready) {
      this.ready = true;
      clearTimeout(this.startupTimer);
      this.initialization.resolve();
      return;
    }
    if (
      !this.ready ||
      message.type !== "frame" ||
      !Number.isSafeInteger(message.sequence) ||
      (message.sequence ?? 0) <= this.lastSequence ||
      typeof message.handle !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(message.handle) ||
      BigInt(message.handle) > 0xffffffffffffffffn ||
      typeof message.width !== "number" ||
      typeof message.height !== "number" ||
      this.leases.size >= 3
    )
      throw new Error("Invalid video helper frame");
    validateTextureSize(message.width, message.height);
    const frame = message as HelperFrame;
    this.lastSequence = frame.sequence;
    this.leases.set(
      frame.sequence,
      setTimeout(() => this.fail(new Error("Video GPU lease timed out")), 10000),
    );
    this.frame(frame);
  }

  release(sequence: number): void {
    if (this.stopped) return;
    const timer = this.leases.get(sequence);
    if (timer === undefined) {
      this.fail(new Error("Unknown video lease"));
      return;
    }
    clearTimeout(timer);
    this.leases.delete(sequence);
    this.write(`release ${sequence}\n`);
  }

  resize(width: number, height: number): void {
    validateTextureSize(width, height);
    this.size = { width, height };
    if (this.resizeTimer !== undefined || this.stopped) return;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      if (this.size) this.write(`resize ${this.size.width} ${this.size.height}\n`);
    }, 50);
  }

  private write(line: string): void {
    if (this.stopped) return;
    if (!this.child.stdin?.writable || this.child.stdin.writableLength > 4096) {
      this.fail(new Error("Video helper command pipe stalled"));
      return;
    }
    this.child.stdin.write(line);
  }

  fail(cause: unknown): void {
    if (this.stopped) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.dispose(error);
    this.failure(error);
  }

  dispose(cause = new Error("Video helper initialization cancelled")): void {
    this.stopped = true;
    clearTimeout(this.startupTimer);
    this.initialization.reject(cause);
    clearTimeout(this.resizeTimer);
    for (const timer of this.leases.values()) clearTimeout(timer);
    this.leases.clear();
    this.pending = "";
  }
}
