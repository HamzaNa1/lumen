import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LibMpv } from "./LibMpv";

export interface MpvProcessOptions {
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly videoOutputArguments?: ReadonlyArray<string>;
  readonly onExit?: (code: number | null) => void;
}

export class MpvProcess {
  private readonly child: ChildProcess | null;
  private readonly native: LibMpv | null;
  private readonly socket: string;
  private exited = false;

  private constructor(
    child: ChildProcess | null,
    native: LibMpv | null,
    socket: string,
    onExit: (code: number | null) => void,
  ) {
    this.child = child;
    this.native = native;
    this.socket = socket;
    child?.once("exit", (code) => {
      this.exited = true;
      onExit(code);
    });
  }

  static start(options: MpvProcessOptions): MpvProcess {
    const executable = process.platform === "win32" ? "mpv.exe" : "mpv";
    const candidates = [
      join(options.resourcesPath, "resources", "native", executable),
      join(options.resourcesPath, "app.asar.unpacked", "resources", "native", executable),
      join(options.cwd, "resources", "native", executable),
      process.platform === "win32" ? "mpv.exe" : "/opt/homebrew/bin/mpv",
      process.platform === "win32" ? "mpv.exe" : "/usr/local/bin/mpv",
      process.platform === "win32" ? "mpv.exe" : "/usr/bin/mpv",
    ];
    const binary = candidates.find(existsSync) ?? executable;
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\lumen-mpv-${process.pid}-${Date.now()}`
        : `/tmp/lumen-mpv-${process.pid}-${Date.now()}.sock`;
    const arguments_ = [
      "--no-config",
      "--load-scripts=no",
      "--idle=yes",
      "--no-terminal",
      `--input-ipc-server=${socketPath}`,
      ...(process.platform === "darwin"
        ? [
            "--vo=gpu",
            "--force-window=yes",
            "--border=no",
            "--auto-window-resize=no",
            "--window-dragging=no",
            "--input-cursor-passthrough=yes",
          ]
        : []),
      ...(options.videoOutputArguments ?? []),
    ];
    if (process.platform === "darwin") {
      const native = LibMpv.start({
        cwd: options.cwd,
        resourcesPath: options.resourcesPath,
        arguments: arguments_,
      });
      return new MpvProcess(null, native, socketPath, options.onExit ?? (() => undefined));
    }
    const child = spawn(binary, arguments_, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    // Drain stderr so buffered mpv errors (e.g. demuxer failures) can never
    // block the child via backpressure; mpv diagnostics are otherwise lost.
    child.stderr?.resume();
    return new MpvProcess(child, null, socketPath, options.onExit ?? (() => undefined));
  }

  get socketPath(): string | null {
    return this.exited ? null : this.socket;
  }

  get process(): ChildProcess | null {
    return this.child;
  }

  stop(): void {
    if (this.exited) return;
    this.exited = true;
    if (this.child !== null) this.child.kill("SIGTERM");
    else this.native?.stop();
  }
}
