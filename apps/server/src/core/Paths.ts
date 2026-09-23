import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import { conflict } from "./Errors";

export const canonicalPath = (path: string): Promise<string> =>
  realpath(resolve(path)).then((value) => resolve(value));

export const isPathWithin = (ancestor: string, candidate: string): boolean => {
  if (ancestor === candidate) return true;
  const path = relative(ancestor, candidate);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
};

const contains = isPathWithin;

export const assertNoRootOverlap = (existingPaths: readonly string[], candidatePath: string): Effect.Effect<void, ReturnType<typeof conflict>> => {
  if (!isAbsolute(candidatePath)) return Effect.fail(conflict("Library root must be absolute"));
  const canonical = resolve(candidatePath);
  const overlapping = existingPaths.find((path) => contains(resolve(path), canonical) || contains(canonical, resolve(path)));
  return overlapping === undefined
    ? Effect.void
    : Effect.fail(conflict(`Library root overlaps existing root: ${overlapping}`));
};

export const safePath = (rootPath: string, relativePath: string): Effect.Effect<string, ReturnType<typeof conflict>> => {
  if (relativePath.includes("\0") || isAbsolute(relativePath)) return Effect.fail(conflict("Invalid relative path"));
  const root = resolve(rootPath);
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    return Effect.fail(conflict("Path escapes library root"));
  }
  return Effect.succeed(target);
};
