import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { productWorkspaces } from "./products";

export const allChecks = { coverage: true, desktop: true, server: true };

export function affectedChecks(root: string, files: readonly string[]) {
  const workspaces = ["apps", "packages"].flatMap((directory) =>
    readdirSync(join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = `${directory}/${entry.name}`;
        const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
        return {
          path,
          name: manifest.name as string,
          dependencies: Object.keys({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
            ...manifest.optionalDependencies,
          }),
        };
      }),
  );
  const affected = new Set<string>();
  for (const file of files) {
    if (/^(README\.md|AGENTS\.md|CLAUDE\.md|docs\/.*)$/.test(file)) continue;
    const workspace = workspaces.find(({ path }) => file.startsWith(`${path}/`));
    // Root configuration, CI, tests, tooling and unknown/deleted workspaces fail open.
    // packages/config is also consumed through relative tsconfig paths.
    if (!workspace || workspace.path === "packages/config") return { ...allChecks };
    affected.add(workspace.name);
  }
  for (let previousSize = -1; previousSize !== affected.size; ) {
    previousSize = affected.size;
    for (const workspace of workspaces)
      if (workspace.dependencies.some((dependency) => affected.has(dependency)))
        affected.add(workspace.name);
  }
  const paths = new Set(
    workspaces.filter(({ name }) => affected.has(name)).map(({ path }) => path),
  );
  return {
    coverage: affected.size > 0,
    desktop: productWorkspaces("desktop").some((path) => paths.has(path)),
    server: productWorkspaces("server").some((path) => paths.has(path)),
  };
}
