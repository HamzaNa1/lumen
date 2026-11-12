import type { HelperFrame } from "./HelperFrames";
import { MacTextureChannel } from "./MacTextureChannel";
import { WindowsTextureHandles } from "./WindowsTextureHandles";

/** How the platform moves the video helper's shared textures into Electron's process. */
export interface VideoTextures {
  readonly pixelFormat: "rgba" | "bgra";
  readonly helperArguments: ReadonlyArray<string>;
  import<T>(
    pid: number,
    frame: HelperFrame,
    consume: (handle: Electron.SharedTextureHandle) => T,
  ): T;
  dispose(): void;
}

const pointer = (value: bigint): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
};

let windowsHandles: WindowsTextureHandles | undefined;

export const createVideoTextures = (): VideoTextures => {
  if (process.platform === "darwin") {
    const channel = new MacTextureChannel();
    return {
      pixelFormat: "bgra",
      helperArguments: [`--lumen-port=${channel.name}`],
      import: (pid, frame, consume) =>
        channel.import(pid, frame, (surface) => consume({ ioSurface: pointer(surface) })),
      dispose: () => channel.dispose(),
    };
  }
  windowsHandles ??= new WindowsTextureHandles();
  const handles = windowsHandles;
  return {
    pixelFormat: "rgba",
    helperArguments: [],
    import: (pid, frame, consume) =>
      handles.import(pid, frame.handle, (ntHandle) => consume({ ntHandle })),
    dispose: () => undefined,
  };
};
