import { existsSync } from "node:fs";
import { join } from "node:path";
import { load, type LibraryHandle } from "koffi";

type NativeHandle = object;
type CreateMpv = () => NativeHandle | null;
type SetOption = (handle: NativeHandle, name: string, value: string) => number;
type InitializeMpv = (handle: NativeHandle) => number;
type DestroyMpv = (handle: NativeHandle) => void;
type ErrorString = (code: number) => string;

const libraryCandidates = (cwd: string, resourcesPath: string): ReadonlyArray<string> => [
  join(resourcesPath, "resources", "native", "libmpv.dylib"),
  join(resourcesPath, "app.asar.unpacked", "resources", "native", "libmpv.dylib"),
  join(cwd, "resources", "native", "libmpv.dylib"),
  join(cwd, "apps", "desktop", "resources", "native", "libmpv.dylib"),
  "/opt/homebrew/opt/mpv/lib/libmpv.dylib",
  "/usr/local/opt/mpv/lib/libmpv.dylib",
];

const option = (argument: string): readonly [name: string, value: string] => {
  const input = argument.slice(2);
  const separator = input.indexOf("=");
  if (separator >= 0) return [input.slice(0, separator), input.slice(separator + 1)];
  if (input.startsWith("no-")) return [input.slice(3), "no"];
  return [input, "yes"];
};

export class LibMpv {
  private constructor(
    private readonly library: LibraryHandle,
    private readonly handle: NativeHandle,
    private readonly destroyMpv: DestroyMpv,
  ) {}

  static start(input: {
    readonly cwd: string;
    readonly resourcesPath: string;
    readonly arguments: ReadonlyArray<string>;
  }): LibMpv {
    const libraryPath = libraryCandidates(input.cwd, input.resourcesPath).find(existsSync);
    if (libraryPath === undefined) {
      throw new Error("Embedded MPV library is missing. Install or package libmpv.dylib.");
    }
    const library = load(libraryPath);
    const createMpv = library.func("void *mpv_create(void)") as CreateMpv;
    const setOption = library.func(
      "int mpv_set_option_string(void *, const char *, const char *)",
    ) as SetOption;
    const initializeMpv = library.func("int mpv_initialize(void *)") as InitializeMpv;
    const destroyMpv = library.func("void mpv_terminate_destroy(void *)") as DestroyMpv;
    const errorString = library.func("const char *mpv_error_string(int)") as ErrorString;
    const handle = createMpv();
    if (handle === null) {
      library.unload();
      throw new Error("Could not create the embedded MPV instance");
    }
    try {
      for (const argument of input.arguments) {
        const [name, value] = option(argument);
        const result = setOption(handle, name, value);
        if (result < 0) throw new Error(`MPV option ${name} failed: ${errorString(result)}`);
      }
      const result = initializeMpv(handle);
      if (result < 0) throw new Error(`MPV initialization failed: ${errorString(result)}`);
      return new LibMpv(library, handle, destroyMpv);
    } catch (cause) {
      destroyMpv(handle);
      library.unload();
      throw cause;
    }
  }

  stop(): void {
    this.destroyMpv(this.handle);
    this.library.unload();
  }
}
