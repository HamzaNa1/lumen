import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { nativeFiles } from "./native-files";

const run = (command: string, args: string[]): string =>
  execFileSync(command, args, { encoding: "utf8" });

const libraries = (directory: string): string[] =>
  nativeFiles(directory).filter((path) => path.endsWith(".dylib"));

const rpaths = (library: string): string[] => {
  // macOS installers target arm64; never merge load commands from different slices.
  const commands = run("otool", ["-arch", "arm64", "-l", library]);
  return [...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset \d+\)/g)].map(
    (match) => match[1] ?? "",
  );
};

export const verifyMacosLibraries = (root: string): void => {
  const files = libraries(root);
  if (files.length === 0) throw new Error(`No macOS libraries found in ${root}`);
  for (const library of files) {
    const paths = rpaths(library);
    if (new Set(paths).size !== paths.length)
      throw new Error(`Duplicate LC_RPATH in ${library}: ${paths.join(", ")}`);
    run("codesign", ["--verify", "--strict", library]);
  }
};

export const prepareMacosLibraries = (root: string): void => {
  for (const library of libraries(root)) {
    const seen = new Set<string>();
    let changed = false;
    const bundledPrefix = "@loader_path/lib/";
    const localPrefix = `@loader_path/${relative(dirname(library), join(root, "lib"))}/`.replace(
      /\/\/$/,
      "/",
    );
    if (localPrefix !== bundledPrefix) {
      const dependencies = run("otool", ["-arch", "arm64", "-L", library]).split("\n").slice(2);
      for (const line of dependencies) {
        const dependency = line.trim().split(" (compatibility version ")[0];
        if (!dependency?.startsWith(bundledPrefix)) continue;
        run("install_name_tool", [
          "-change",
          dependency,
          `${localPrefix}${dependency.slice(bundledPrefix.length)}`,
          library,
        ]);
        changed = true;
      }
    }
    for (const path of rpaths(library)) {
      if (seen.has(path)) {
        run("install_name_tool", ["-delete_rpath", path, library]);
        changed = true;
      }
      seen.add(path);
    }
    if (changed) {
      run("codesign", ["--force", "--sign", "-", library]);
      console.log(`Repaired bundled library: ${library}`);
    }
  }
  verifyMacosLibraries(root);
};
