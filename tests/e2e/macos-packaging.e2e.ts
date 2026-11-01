import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { repository } from "./support/server";

const prepare = join(repository, "apps/desktop/scripts/prepare-macos-libraries.ts");
const verify = join(repository, "apps/desktop/scripts/verify-native-binaries.ts");
const test = base.extend<{
  native: { root: string; run: (command: string, args: string[]) => string; loader: string };
}>({
  native: async ({ playwright: _playwright }, use) => {
    test.skip(process.platform !== "darwin", "Requires the macOS linker and loader");
    const workspace = mkdtempSync(join(tmpdir(), "lumen macos packaging "));
    const root = join(workspace, "resources/native");
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { cwd: workspace, encoding: "utf8" });
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(workspace, "load.c"),
        `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  void *lib = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!lib) { fprintf(stderr, "%s\\n", dlerror()); return 1; }
  int (*answer)(void) = dlsym(lib, "answer");
  if (!answer || answer() != 42) return 2;
  dlclose(lib);
  return 0;
}
`,
      );
      const loader = join(workspace, "load");
      run("clang", ["load.c", "-o", loader]);
      await use({ root, run, loader });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
});

for (const [location, copies] of [
  ["", 2],
  ["lib", 3],
] as const)
  test(`macOS packaging repairs ${copies} duplicate search paths in ${location || "root"}`, ({
    native,
  }) => {
    const { root, run, loader } = native;
    const source = join(root, "fixture.c");
    writeFileSync(source, "int answer(void) { return 42; }\n");
    const library = join(root, location, "libmpv.dylib");
    mkdirSync(dirname(library), { recursive: true });
    run("clang", [
      "-dynamiclib",
      source,
      "-o",
      library,
      "-Wl,-headerpad_max_install_names",
      "-Wl,-rpath,@loader_path/lib/",
      "-Wl,-rpath,/usr/lib/swift",
      ...Array.from({ length: copies - 1 }, (_, index) => `-Wl,-rpath,@loader_path/other${index}/`),
    ]);
    for (let index = 0; index < copies - 1; index++)
      run("install_name_tool", [
        "-rpath",
        `@loader_path/other${index}/`,
        "@loader_path/lib/",
        library,
      ]);
    run("codesign", ["--force", "--sign", "-", library]);
    const before = spawnSync(loader, [library], { encoding: "utf8" });
    expect(before.status).not.toBe(0);
    expect(before.stderr).toContain("duplicate LC_RPATH");
    if (!location) {
      const rejected = spawnSync("bun", [verify, "--write-manifest"], {
        cwd: dirname(dirname(root)),
        encoding: "utf8",
        env: { ...process.env, LUMEN_MPV_VERSION: "fixture" },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("Duplicate LC_RPATH");
      expect(existsSync(join(root, "mpv-manifest.json"))).toBe(false);
    }
    run("bun", [prepare, root]);
    const commands = run("otool", ["-l", library]);
    expect(commands.match(/path @loader_path\/lib\//g)).toHaveLength(1);
    expect(commands).toContain("path /usr/lib/swift");
    run("codesign", ["--verify", "--strict", library]);
    run(loader, [library]);
    const prepared = readFileSync(library);
    run("bun", [prepare, root]);
    expect(readFileSync(library)).toEqual(prepared);
  });

test("macOS packaging resolves bundled libraries relative to each dependent library", ({
  native,
}) => {
  const { root, run, loader } = native;
  mkdirSync(join(root, "lib"));
  const leaf = join(root, "lib/leaf.dylib");
  const leafSource = join(root, "leaf.c");
  writeFileSync(leafSource, "int leaf(void) { return 42; }\n");
  run("clang", [
    "-dynamiclib",
    leafSource,
    "-o",
    leaf,
    "-Wl,-install_name,@loader_path/lib/leaf.dylib",
  ]);
  const source = join(root, "parent.c");
  writeFileSync(source, "extern int leaf(void); int answer(void) { return leaf(); }\n");
  const library = join(root, "lib/parent.dylib");
  run("clang", ["-dynamiclib", source, leaf, "-o", library, "-Wl,-headerpad_max_install_names"]);
  const before = spawnSync(loader, [library], { encoding: "utf8" });
  expect(before.status).not.toBe(0);
  expect(before.stderr).toContain("Library not loaded: @loader_path/lib/leaf.dylib");
  run("bun", [prepare, root]);
  run("codesign", ["--verify", "--strict", library]);
  run(loader, [library]);
  const prepared = readFileSync(library);
  run("bun", [prepare, root]);
  expect(readFileSync(library)).toEqual(prepared);
});
