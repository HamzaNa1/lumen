import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Product, productWorkspaces, workspaceFilters } from "./products";
import { git, latestStableTag, repositoryRoot, run } from "./releases";

export const createVerificationWorkspace = ({
  product,
  candidate,
  released,
  workspace,
}: {
  product: Product;
  candidate: string;
  released: string;
  workspace: string;
}): void => {
  mkdirSync(workspace, { recursive: true });
  // Copy the candidate's tests so relative fixture imports resolve through this workspace.
  // Symlinking the tests would resolve them back into the unreleased source pair.
  for (const path of ["tests", "scripts", "playwright.config.ts", "tsconfig.base.json"])
    if (existsSync(join(candidate, path)))
      cpSync(join(candidate, path), join(workspace, path), { recursive: true });
  const owned = productWorkspaces(product);
  const counterpart = product === "server" ? "desktop" : "server";
  const counterpartWorkspaces = productWorkspaces(counterpart);
  const paths = new Set([
    ...owned,
    ...counterpartWorkspaces,
    "packages/config",
    "package.json",
    "node_modules",
  ]);
  for (const path of paths) {
    const root =
      owned.includes(path) || !counterpartWorkspaces.includes(path) ? candidate : released;
    const source = join(root, path);
    if (!existsSync(source)) continue;
    const target = join(workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    // Keep each real workspace's own dependencies, including the stable counterpart's
    // contracts/database. A merged dependency tree could conceal a version mismatch.
    symlinkSync(source, target, statSync(source).isDirectory() ? "junction" : "file");
  }
};

export const withReleasedCounterpart = (
  product: Product,
  verify: (workspace: string) => void,
): void => {
  const counterpart = product === "server" ? "desktop" : "server";
  const tag = latestStableTag(counterpart, git("tag", "--list").split("\n"));
  if (tag === undefined)
    throw new Error(
      `No stable ${counterpart} release tag found. Fetch release tags before checking compatibility.`,
    );
  const temporary = mkdtempSync(join(tmpdir(), "lumen-release-verification-"));
  const released = join(temporary, "released");
  const workspace = join(temporary, "verification");
  let added = false;
  try {
    run("git", ["worktree", "add", "--detach", released, tag]);
    added = true;
    const workspaces = productWorkspaces(counterpart).filter((path) =>
      existsSync(join(released, path, "package.json")),
    );
    run(
      process.execPath,
      ["install", "--frozen-lockfile", ...workspaceFilters(workspaces)],
      released,
    );
    createVerificationWorkspace({ product, candidate: repositoryRoot, released, workspace });
    console.log(`Checking candidate ${product} against ${tag}`);
    verify(workspace);
  } finally {
    try {
      if (added)
        run("git", ["-c", "core.longpaths=true", "worktree", "remove", "--force", released]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
};
