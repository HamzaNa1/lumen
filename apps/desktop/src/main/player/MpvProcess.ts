import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface MpvProcessOptions {
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly onExit?: (code: number | null) => void;
}

export class MpvProcess {
  private readonly child: ChildProcess;
  private readonly socket: string;
  private exited = false;

  private constructor(child: ChildProcess, socket: string, onExit: (code: number | null) => void) {
    this.child = child;
    this.socket = socket;
    child.once("exit", (code) => {
      this.exited = true;
      onExit(code);
    });
  }

  static start(options: MpvProcessOptions): MpvProcess {
    const executable = process.platform === "win32" ? "mpv.exe" : "mpv";
    const candidates = [
      join(options.resourcesPath, "resources", "native", executable),
      join(options.cwd, "resources", "native", executable),
      process.platform === "win32" ? "mpv.exe" : "/opt/homebrew/bin/mpv",
      process.platform === "win32" ? "mpv.exe" : "/usr/local/bin/mpv",
      process.platform === "win32" ? "mpv.exe" : "/usr/bin/mpv",
    ];
    const binary = candidates.find(existsSync) ?? executable;
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\lumen-mpv-${process.pid}-${Date.now()}` : `/tmp/lumen-mpv-${process.pid}-${Date.now()}.sock`;
    const child = spawn(binary, [
      "--no-config",
      "--load-scripts=no",
      "--idle=yes",
      "--demuxer=ffmpeg",
      "--no-terminal",
      `--input-ipc-server=${socketPath}`,
    ], { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    return new MpvProcess(child, socketPath, options.onExit ?? (() => undefined));
  }

  get socketPath(): string | null {
    return this.exited ? null : this.socket;
  }

  get process(): ChildProcess {
    return this.child;
  }

  stop(): void {
    if (!this.exited) this.child.kill("SIGTERM");
  }
}
