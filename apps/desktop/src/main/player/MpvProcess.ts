import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type HelperFrame, HelperFrames } from "./HelperFrames";
import { LibMpv } from "./LibMpv";
import { mpvCacheArguments } from "./MpvCache";
import { mpvPitchArguments } from "./MpvSynchronization";

export interface MpvProcessOptions {
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly videoOutputArguments?: ReadonlyArray<string>;
  readonly onFrame?: (frame: HelperFrame) => void;
  readonly onFailure?: (error: Error) => void;
  readonly onExit?: (code: number | null) => void;
}

export class MpvProcess {
  private readonly child: ChildProcess | null;
  frames: HelperFrames | undefined;
  private readonly native: LibMpv | null;
  private readonly socket: string;
  private readonly childExit: Promise<void> | null;
  private exited = false;
  private stopping: Promise<void> | null = null;
  private startupError: Error | null = null;

  private constructor(
    child: ChildProcess | null,
    native: LibMpv | null,
    socket: string,
    onExit: (code: number | null) => void,
  ) {
    this.child = child;
    this.native = native;
    this.socket = socket;
    this.childExit =
      child === null
        ? null
        : new Promise((resolve) => {
            child.once("exit", (code) => {
              this.frames?.dispose();
              this.exited = true;
              resolve();
              onExit(code);
            });
            child.once("error", (cause) => {
              this.startupError = cause;
              this.frames?.dispose();
              this.exited = true;
              resolve();
            });
          });
  }

  static start(options: MpvProcessOptions): MpvProcess {
    const executable = process.platform === "win32" ? "Lumen Video Helper.exe" : "mpv";
    const candidates = [
      join(options.resourcesPath, "resources", "native", executable),
      join(options.resourcesPath, "app.asar.unpacked", "resources", "native", executable),
      join(options.cwd, "resources", "native", executable),
      process.platform === "win32" ? "Lumen Video Helper.exe" : "/opt/homebrew/bin/mpv",
      process.platform === "win32" ? "Lumen Video Helper.exe" : "/usr/local/bin/mpv",
      process.platform === "win32" ? "Lumen Video Helper.exe" : "/usr/bin/mpv",
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
      // Keep decoding and the playback clock active without opening a speaker device in E2E.
      ...(process.env.LUMEN_E2E_SILENT_AUDIO === "1" ? ["--ao=null"] : []),
      ...mpvPitchArguments,
      ...(process.platform === "win32" ? [`--lumen-parent-pid=${process.pid}`] : []),
      // Read ahead of playback whatever the source, paused or not: a watch group waits for it.
      ...mpvCacheArguments,
      `--input-ipc-server=${socketPath}`,
      ...(process.platform === "darwin"
        ? [
            "--vo=gpu",
            "--force-window=yes",
            "--border=no",
            "--native-fs=no",
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
      stdio: process.platform === "win32" ? ["pipe", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    // Drain stderr so buffered mpv errors (e.g. demuxer failures) can never
    // block the child via backpressure; mpv diagnostics are otherwise lost.
    child.stderr?.resume();
    const instance = new MpvProcess(child, null, socketPath, options.onExit ?? (() => undefined));
    if (process.platform === "win32")
      instance.frames = new HelperFrames(child, options.onFrame ?? (() => undefined), (error) => {
        instance.startupError = error;
        options.onFailure?.(error);
        void instance.stop();
      });
    return instance;
  }

  get socketPath(): string | null {
    return this.exited ? null : this.socket;
  }

  get process(): ChildProcess | null {
    return this.child;
  }

  get error(): Error | null {
    return this.startupError;
  }

  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    if (this.exited) return Promise.resolve();
    this.exited = true;
    this.frames?.dispose();
    if (this.child !== null) {
      // A replacement must not share the host window/audio device with the
      // dying process. kill() only sends a signal; it does not wait for exit.
      const forceKill = setTimeout(() => this.child?.kill("SIGKILL"), 2_000);
      forceKill.unref();
      this.stopping = (this.childExit ?? Promise.resolve()).finally(() => clearTimeout(forceKill));
      if (this.frames && this.child.stdin?.writable) this.child.stdin.end("quit\n");
      else this.child.kill("SIGTERM");
    } else {
      this.stopping = this.native?.stop() ?? Promise.resolve();
    }
    return this.stopping;
  }
}
