import { lstat } from "node:fs/promises";
import {
  artwork as artworkTable,
  Database,
  libraryRoots,
  mediaSources,
  streamSidecars,
  streams,
} from "@lumen/database";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { ServerConfig } from "../config/Config";
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

export interface ArtworkFile extends AssetFile {
  /** The original's width in pixels, as the catalog recorded it. */
  readonly width: number;
}

export interface AssetServiceShape {
  readonly artwork: (
    principal: AuthPrincipal,
    artworkId: string,
    nowMs: number,
  ) => Effect.Effect<ArtworkFile, unknown>;
  /**
   * Jellyfin compatibility: an image for a caller with no account, because Jellyfin apps load
   * artwork without credentials. Only the Jellyfin module calls it; remove it with that module.
   */
  readonly publicArtwork: (artworkId: string) => Effect.Effect<ArtworkFile, unknown>;
  readonly sidecar: (
    principal: AuthPrincipal,
    sidecarId: string,
    nowMs: number,
  ) => Effect.Effect<AssetFile, unknown>;
}

export const makeAssetService = (config?: ServerConfig) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const access = yield* AccessControl;
    const artworkRow = (artworkId: string) =>
      database
        .select({
          libraryId: artworkTable.libraryId,
          rootPath: libraryRoots.path,
          path: artworkTable.relativePath,
          mimeType: artworkTable.mimeType,
          width: artworkTable.width,
          contentHash: artworkTable.contentHash,
        })
        .from(artworkTable)
        .leftJoin(mediaSources, eq(mediaSources.id, artworkTable.sourceId))
        .leftJoin(libraryRoots, eq(libraryRoots.id, mediaSources.rootId))
        .where(eq(artworkTable.id, artworkId))
        .get();
    const artworkFile = Effect.fn("Assets.artworkFile")(function* (
      row: NonNullable<Effect.Success<ReturnType<typeof artworkRow>>>,
    ) {
      const allowedRoot = row.rootPath ?? config?.dataDir;
      if (allowedRoot === undefined) return yield* notFound("Artwork not found");
      const paths = yield* Effect.all([
        Effect.promise(() => canonicalPath(allowedRoot)),
        Effect.promise(() => canonicalPath(row.path)),
      ]).pipe(Effect.catch(() => notFound("Artwork not found")));
      const [root, file] = paths;
      if (!isPathWithin(root, file)) return yield* notFound("Artwork not found");
      const details = yield* Effect.promise(() => lstat(file)).pipe(
        Effect.catch(() => notFound("Artwork not found")),
      );
      if (!details.isFile() || details.isSymbolicLink())
        return yield* notFound("Artwork not found");
      return {
        path: file,
        size: details.size,
        modifiedAtMs: Math.trunc(details.mtimeMs),
        mimeType: row.mimeType,
        width: row.width,
      } satisfies ArtworkFile;
    });
    const artwork: AssetServiceShape["artwork"] = Effect.fn("Assets.artwork")(
      function* (principal, artworkId, nowMs) {
        const row = yield* artworkRow(artworkId);
        if (row == null) return yield* notFound("Artwork not found");
        yield* access.requireLibrary(principal, row.libraryId, "library:read", nowMs);
        return yield* artworkFile(row);
      },
    );
    // Jellyfin compatibility; see `publicArtwork` in AssetServiceShape.
    const publicArtwork: AssetServiceShape["publicArtwork"] = Effect.fn("Assets.publicArtwork")(
      function* (artworkId) {
        const row = yield* artworkRow(artworkId);
        if (row == null) return yield* notFound("Artwork not found");
        return yield* artworkFile(row);
      },
    );
    const sidecar: AssetServiceShape["sidecar"] = Effect.fn("Assets.sidecar")(
      function* (principal, sidecarId, nowMs) {
        const row = yield* database
          .select({
            libraryId: mediaSources.libraryId,
            rootPath: libraryRoots.path,
            path: streamSidecars.relativePath,
            mediaType: streamSidecars.mediaType,
          })
          .from(streamSidecars)
          .innerJoin(streams, eq(streams.id, streamSidecars.streamId))
          .innerJoin(mediaSources, eq(mediaSources.id, streams.sourceId))
          .innerJoin(libraryRoots, eq(libraryRoots.id, mediaSources.rootId))
          .where(eq(streamSidecars.id, sidecarId))
          .get();
        if (row == null) return yield* notFound("Sidecar not found");
        const [root, file] = yield* Effect.all([
          Effect.promise(() => canonicalPath(row.rootPath)),
          Effect.promise(() => canonicalPath(row.path)),
        ]);
        if (!isPathWithin(root, file)) return yield* notFound("Sidecar not found");
        yield* access.requireLibrary(principal, row.libraryId, "library:read", nowMs);
        const details = yield* Effect.promise(async () => {
          const { lstat } = await import("node:fs/promises");
          return lstat(row.path);
        });
        return {
          path: file,
          size: details.size,
          modifiedAtMs: Math.trunc(details.mtimeMs),
          mimeType: row.mediaType ?? "application/octet-stream",
        };
      },
    );
    return { artwork, publicArtwork, sidecar };
  });

export class AssetService extends Context.Service<AssetService, AssetServiceShape>()(
  "@lumen/server/Assets",
) {}
export const AssetServiceLive = Layer.effect(AssetService, makeAssetService());
export const AssetServiceLiveWithConfig = (config: ServerConfig) =>
  Layer.effect(AssetService, makeAssetService(config));
