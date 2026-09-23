import { Database } from "@lumen/database";
import { sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { notFound } from "../core/Errors";
import { canonicalPath, isPathWithin } from "../core/Paths";
import { AccessControl } from "../services/AccessControl";
import type { AuthPrincipal } from "../services/AuthService";

export interface AssetFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly mimeType: string;
}

export interface AssetServiceShape {
  readonly artwork: (principal: AuthPrincipal, artworkId: string, nowMs: number) => Effect.Effect<AssetFile, unknown>;
  readonly sidecar: (principal: AuthPrincipal, sidecarId: string, nowMs: number) => Effect.Effect<AssetFile, unknown>;
}

export const makeAssetService = Effect.gen(function* () {
  const database = yield* Database;
  const access = yield* AccessControl;
  const artwork: AssetServiceShape["artwork"] = Effect.fn("Assets.artwork")(function* (principal, artworkId, nowMs) {
    const row = yield* database.get<{ libraryId: string; rootPath: string; path: string; size: number; modifiedAtMs: number; mimeType: string }>(sql`
      SELECT a.library_id AS libraryId, r.path AS rootPath, a.relative_path AS path, s.file_size_bytes AS size, s.modified_at_ms AS modifiedAtMs, a.mime_type AS mimeType
      FROM artwork a JOIN media_sources s ON s.id = a.source_id JOIN library_roots r ON r.id = s.root_id WHERE a.id = ${artworkId}
    `);
    if (row == null || row.size == null) return yield* notFound("Artwork not found");
    const [root, file] = yield* Effect.all([Effect.promise(() => canonicalPath(row.rootPath)), Effect.promise(() => canonicalPath(row.path))]);
    if (!isPathWithin(root, file)) return yield* notFound("Artwork not found");
    yield* access.requireLibrary(principal, row.libraryId, "library:read", nowMs);
    return { ...row, path: file };
  });
  const sidecar: AssetServiceShape["sidecar"] = Effect.fn("Assets.sidecar")(function* (principal, sidecarId, nowMs) {
    const row = yield* database.get<{ libraryId: string; rootPath: string; path: string; mediaType: string | null }>(sql`
      SELECT s.library_id AS libraryId, r.path AS rootPath, sc.relative_path AS path, sc.media_type AS mediaType
      FROM stream_sidecars sc
      JOIN streams st ON st.id = sc.stream_id
      JOIN media_sources s ON s.id = st.source_id
      JOIN library_roots r ON r.id = s.root_id
      WHERE sc.id = ${sidecarId}
    `);
    if (row == null) return yield* notFound("Sidecar not found");
    const [root, file] = yield* Effect.all([Effect.promise(() => canonicalPath(row.rootPath)), Effect.promise(() => canonicalPath(row.path))]);
    if (!isPathWithin(root, file)) return yield* notFound("Sidecar not found");
    yield* access.requireLibrary(principal, row.libraryId, "library:read", nowMs);
    const details = yield* Effect.promise(async () => {
      const { lstat } = await import("node:fs/promises");
      return lstat(row.path);
    });
    return { path: file, size: details.size, modifiedAtMs: Math.trunc(details.mtimeMs), mimeType: row.mediaType ?? "application/octet-stream" };
  });
  return { artwork, sidecar };
});

export class AssetService extends Context.Service<AssetService, AssetServiceShape>()("@lumen/server/Assets") {}
export const AssetServiceLive = Layer.effect(AssetService, makeAssetService);
