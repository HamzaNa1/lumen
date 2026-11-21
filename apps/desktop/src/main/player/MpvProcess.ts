import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import { composesVideo } from "../../shared/videoCompositor";
import { type HelperFrame, HelperFrames } from "./HelperFrames";
import { mpvCacheArguments } from "./MpvCache";
import { mpvPitchArguments } from "./MpvSynchronization";
import { createVideoTextures, type VideoTextures } from "./VideoTextures";

export interface MpvProcessOptions {
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly videoOutputArguments?: ReadonlyArray<string>;
  readonly onFrame?: (frame: HelperFrame) => void;
  readonly onFailure?: (error: Error) => void;
  readonly onExit?: (code: number | null) => void;
}

const nativeDirectories = (resourcesPath: string, cwd: string): string[] => [
  join(resourcesPath, "resources", "native"),
  join(resourcesPath, "app.asar.unpacked", "resources", "native"),
  join(cwd, "resources", "native"),
];

const MpvManifest = Schema.Struct({ mpvVersion: Schema.String });

/** The MPV a packaged build bundles, as the build recorded it. Null for one it did not package. */
export const bundledMpvVersion = async (
  resourcesPath: string,
  cwd: string,
): Promise<string | null> => {
  const path = nativeDirectories(resourcesPath, cwd)
    .map((directory) => join(directory, "mpv-manifest.json"))
    .find(existsSync);
  if (path === undefined) return null;
  try {
    return Schema.decodeUnknownSync(MpvManifest)(JSON.parse(await readFile(path, "utf8")))
      .mpvVersion;
  } catch {
    return null;
  }
};

export class MpvProcess {
  private readonly child: ChildProcess;
  frames: HelperFrames | undefined;
  readonly textures: VideoTextures | undefined;
  private readonly socket: string;
  private readonly childExit: Promise<void>;
  private exited = false;
  private stopping: Promise<void> | null = null;
  private startupError: Error | null = null;

  private constructor(
    child: ChildProcess,
    textures: VideoTextures | undefined,
    socket: string,
    onExit: (code: number | null) => void,
  ) {
    this.child = child;
    this.textures = textures;
    this.socket = socket;
    this.childExit = new Promise((resolve) => {
      child.once("exit", (code) => {
        this.frames?.dispose();
        this.textures?.dispose();
        this.exited = true;
        resolve();
        onExit(code);
      });
      child.once("error", (cause) => {
        this.startupError = cause;
        this.frames?.dispose();
        this.textures?.dispose();
        this.exited = true;
        resolve();
      });
    });
  }

  static start(options: MpvProcessOptions): MpvProcess {
    const helper = composesVideo(process.platform);
    const executable =
      process.platform === "win32"
        ? "Lumen Video Helper.exe"
        : helper
          ? "Lumen Video Helper"
          : "mpv";
    const candidates = [
      ...nativeDirectories(options.resourcesPath, options.cwd).map((directory) =>
        join(directory, executable),
      ),
      ...(helper ? [] : ["/usr/local/bin/mpv", "/usr/bin/mpv"]),
    ];
    const binary = candidates.find(existsSync) ?? executable;
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\lumen-mpv-${process.pid}-${Date.now()}`
        : `/tmp/lumen-mpv-${process.pid}-${Date.now()}.sock`;
    const textures = helper ? createVideoTextures() : undefined;
    const arguments_ = [
      "--no-config",
      "--load-scripts=no",
      // Built-in CLI UI scripts ignore --load-scripts=no; Lumen draws its own controls and
      // initializing the OSC runs libass/fontconfig synchronously on MPV's main thread.
      ...(helper ? [] : ["--osc=no", "--osd-bar=no", "--load-stats-overlay=no"]),
      "--idle=yes",
      // Keep completed media seekable without changing the shared pause state.
      "--keep-open=yes",
      "--keep-open-pause=no",
      "--ytdl=no",
      "--force-window=yes",
      "--no-terminal",
      // Keep decoding and the playback clock active without opening a speaker device in E2E.
      ...(process.env.LUMEN_E2E_SILENT_AUDIO === "1" ? ["--ao=null"] : []),
      ...mpvPitchArguments,
      ...(helper ? [`--lumen-parent-pid=${process.pid}`] : []),
      ...(textures?.helperArguments ?? []),
      // Read ahead of playback whatever the source, paused or not: a watch group waits for it.
      ...mpvCacheArguments,
      `--input-ipc-server=${socketPath}`,
      ...(options.videoOutputArguments ?? []),
    ];
    let child: ChildProcess;
    try {
      child = spawn(binary, arguments_, {
        shell: false,
        stdio: helper ? ["pipe", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      textures?.dispose();
      throw cause;
    }
    // Drain stderr so buffered mpv errors (e.g. demuxer failures) can never
    // block the child via backpressure; mpv diagnostics are otherwise lost.
    child.stderr?.resume();
    const instance = new MpvProcess(
      child,
      textures,
      socketPath,
      options.onExit ?? (() => undefined),
    );
    if (helper)
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

  get process(): ChildProcess {
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
    // A replacement must not share the host window/audio device with the
    // dying process. kill() only sends a signal; it does not wait for exit.
    const forceKill = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
    forceKill.unref();
    this.stopping = this.childExit.finally(() => {
      clearTimeout(forceKill);
      this.textures?.dispose();
    });
    if (this.frames && this.child.stdin?.writable) this.child.stdin.end("quit\n");
    else this.requestQuit();
    return this.stopping;
  }

  /**
   * MPV 0.37 on Linux can leave SIGTERM unanswered after a seek while paused, until the
   * force-kill, yet quits at once when asked over IPC. The signal is for an unreachable socket.
   */
  private requestQuit(): void {
    let connected = false;
    const socket = createConnection(this.socket);
    socket.once("connect", () => {
      connected = true;
      socket.end(`${JSON.stringify({ command: ["quit"] })}\n`);
    });
    socket.on("error", () => {
      socket.destroy();
      if (!connected) this.child.kill("SIGTERM");
    });
  }
}
