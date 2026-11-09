import { type DownloadSyncResult, type DownloadTicket, mediaRevision } from "@lumen/contracts";
import {
  catalogItemSources,
  catalogItems,
  Database,
  devices,
  downloadGrants,
  itemWatchStates,
  libraryRoots,
  mediaSourceAvailability,
  mediaSources,
  tracks,
  users,
} from "@lumen/database";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { forbidden, notFound } from "../core/Errors";
import { canonicalPath, isPathWithin } from "../core/Paths";
import { hashToken, newOpaqueToken, newUuid } from "../core/Security";
import { mediaType } from "../media/MediaType";
import type { AccessControlShape } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";

/** How long a device may keep fetching without checking in; each check-in renews it. */
export const downloadGrantLifetimeMs = 30 * 24 * 3_600_000;

export interface AuthorizedMedia {
  readonly absolutePath: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly mimeType: string;
  /** What admission and logs count requests against: a playback session, or a download. */
  readonly sessionId: string;
  readonly userId: string;
}

type Describe = (
  principal: AuthPrincipal,
  trackId: string,
) => Effect.Effect<
  Pick<
    DownloadTicket,
    "sourceId" | "title" | "titleId" | "durationSeconds" | "streams" | "media" | "trackMemory"
  >,
  unknown
>;

const mayDownload = (user: {
  readonly role: string;
  readonly canDownload?: boolean | undefined;
}): boolean => user.role === "admin" || user.canDownload !== false;

export const makeDownloadGrants = Effect.fnUntraced(function* (options: {
  readonly access: AccessControlShape;
  readonly resolveTrack: (requestedId: string) => Effect.Effect<string, unknown>;
  readonly describe: Describe;
}) {
  const database = yield* Database;
  const { access } = options;

  /** The catalog item a request names, whether it named the item or its file. */
  const itemFor = Effect.fn("Downloads.itemFor")(function* (requestedId: string, trackId: string) {
    const direct = yield* database
      .select({ id: catalogItems.id })
      .from(catalogItems)
      .where(eq(catalogItems.id, requestedId))
      .get();
    if (direct != null) return direct.id;
    const linked = yield* database
      .select({ id: catalogItemSources.itemId })
      .from(tracks)
      .innerJoin(catalogItemSources, eq(catalogItemSources.sourceId, tracks.sourceId))
      .where(eq(tracks.id, trackId))
      .limit(1)
      .get();
    if (linked == null) return yield* notFound("Item not found");
    return linked.id;
  });

  const issue = Effect.fn("Downloads.issue")(function* (
    principal: AuthPrincipal,
    requestedId: string,
    nowMs: number,
  ) {
    if (!mayDownload(principal.user)) return yield* forbidden("Downloads are turned off for you");
    const device = yield* database
      .select({ revokedAtMs: devices.revokedAtMs })
      .from(devices)
      .where(and(eq(devices.id, principal.deviceId), eq(devices.userId, principal.user.id)))
      .get();
    if (device == null || device.revokedAtMs !== null)
      return yield* forbidden("Device is unavailable");
    const trackId = yield* options.resolveTrack(requestedId);
    yield* access.requireTrack(principal, trackId, "playback:control", nowMs);
    const itemId = yield* itemFor(requestedId, trackId);
    const playable = yield* options.describe(principal, trackId);
    const { sizeBytes, revision } = playable.media;
    if (sizeBytes == null || sizeBytes <= 0 || revision === undefined)
      return yield* notFound("Media source not found");
    const grantToken = newOpaqueToken();
    const expiresAtMs = nowMs + downloadGrantLifetimeMs;
    // One grant per device and file: asking again issues a fresh token under the same download.
    const [grant] = yield* database
      .insert(downloadGrants)
      .values({
        id: newUuid(),
        userId: principal.user.id,
        deviceId: principal.deviceId,
        trackId,
        itemId,
        tokenHash: hashToken(grantToken),
        createdAtMs: nowMs,
        expiresAtMs,
        revokedAtMs: null,
      })
      .onConflictDoUpdate({
        target: [downloadGrants.deviceId, downloadGrants.trackId],
        set: {
          itemId,
          tokenHash: hashToken(grantToken),
          createdAtMs: nowMs,
          expiresAtMs,
          revokedAtMs: null,
        },
      })
      .returning({ id: downloadGrants.id });
    if (grant === undefined) return yield* Effect.die(new Error("Download grant upsert failed"));
    return {
      downloadId: grant.id,
      itemId,
      streamPath: `/api/v1/media/${encodeURIComponent(trackId)}`,
      grantToken,
      revision,
      sizeBytes,
      mimeType: playable.media.mimeType ?? "application/octet-stream",
      expiresAtMs,
      ...playable,
    } satisfies DownloadTicket;
  });

  /** Withdraws downloads the server no longer lets this user keep, so devices delete them. */
  const revoke = Effect.fn("Downloads.revoke")(function* (
    principal: AuthPrincipal,
    downloadId: string,
    nowMs: number,
  ) {
    yield* database
      .update(downloadGrants)
      .set({ revokedAtMs: sql`coalesce(${downloadGrants.revokedAtMs}, ${nowMs})` })
      .where(
        and(
          eq(downloadGrants.id, downloadId),
          eq(downloadGrants.userId, principal.user.id),
          eq(downloadGrants.deviceId, principal.deviceId),
        ),
      );
  });

  const sync = Effect.fn("Downloads.sync")(function* (
    principal: AuthPrincipal,
    held: ReadonlyArray<{ readonly downloadId: string; readonly revision: string }>,
    nowMs: number,
  ) {
    const ids = [...new Set(held.map((entry) => entry.downloadId))];
    const rows =
      ids.length === 0
        ? []
        : yield* database
            .select({
              id: downloadGrants.id,
              trackId: downloadGrants.trackId,
              itemId: downloadGrants.itemId,
              revokedAtMs: downloadGrants.revokedAtMs,
              size: mediaSources.fileSizeBytes,
              modifiedAtMs: sql<number>`coalesce(${mediaSources.modifiedAtMs}, 0)`,
              completed: sql<number | null>`${itemWatchStates.completed}`,
              deviceRevokedAtMs: devices.revokedAtMs,
            })
            .from(downloadGrants)
            .innerJoin(tracks, eq(tracks.id, downloadGrants.trackId))
            .innerJoin(mediaSources, eq(mediaSources.id, tracks.sourceId))
            .innerJoin(
              devices,
              and(
                eq(devices.id, downloadGrants.deviceId),
                eq(devices.userId, downloadGrants.userId),
              ),
            )
            .leftJoin(
              itemWatchStates,
              and(
                eq(itemWatchStates.itemId, downloadGrants.itemId),
                eq(itemWatchStates.userId, downloadGrants.userId),
              ),
            )
            .where(
              and(
                inArray(downloadGrants.id, ids),
                eq(downloadGrants.userId, principal.user.id),
                eq(downloadGrants.deviceId, principal.deviceId),
              ),
            );
    const allowed = mayDownload(principal.user);
    const results: DownloadSyncResult[] = [];
    const renewed: string[] = [];
    const withdrawn: string[] = [];
    for (const entry of held) {
      const row = rows.find((candidate) => candidate.id === entry.downloadId);
      const revoked: DownloadSyncResult = {
        downloadId: entry.downloadId,
        status: "revoked",
        revision: null,
        expiresAtMs: null,
        completed: row?.completed === 1,
      };
      // A grant that lapsed while the device was away is renewed below if it is still allowed:
      // the lapse only stops a stale token from fetching, it does not take the download back.
      if (
        row === undefined ||
        row.revokedAtMs !== null ||
        row.deviceRevokedAtMs !== null ||
        row.size === null
      ) {
        results.push(revoked);
        continue;
      }
      const permitted =
        allowed &&
        (yield* access.requireTrack(principal, row.trackId, "playback:control", nowMs).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ));
      if (!permitted) {
        withdrawn.push(row.id);
        results.push(revoked);
        continue;
      }
      const revision = mediaRevision(row.size, row.modifiedAtMs);
      renewed.push(row.id);
      results.push({
        downloadId: row.id,
        status: revision === entry.revision ? "valid" : "changed",
        revision,
        expiresAtMs: nowMs + downloadGrantLifetimeMs,
        completed: row.completed === 1,
      });
    }
    if (renewed.length > 0)
      yield* database
        .update(downloadGrants)
        .set({ expiresAtMs: nowMs + downloadGrantLifetimeMs })
        .where(and(inArray(downloadGrants.id, renewed), isNull(downloadGrants.revokedAtMs)));
    if (withdrawn.length > 0)
      yield* database
        .update(downloadGrants)
        .set({ revokedAtMs: nowMs })
        .where(and(inArray(downloadGrants.id, withdrawn), isNull(downloadGrants.revokedAtMs)));
    return results;
  });

  /**
   * Authorizes a media request made with a download grant. Everything that allowed the download
   * is checked again on every request, so withdrawing any of it stops the transfer at once.
   */
  const authorize = Effect.fn("Downloads.authorize")(function* (
    grantToken: string,
    trackId: string,
    nowMs: number,
  ) {
    const row = yield* database
      .select({
        id: downloadGrants.id,
        user: {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
          isActive: users.isActive,
          canDownload: users.canDownload,
          createdAtMs: users.createdAtMs,
          updatedAtMs: users.updatedAtMs,
        },
        deviceId: downloadGrants.deviceId,
        absolutePath: mediaSources.absolutePath,
        rootPath: libraryRoots.path,
        size: mediaSources.fileSizeBytes,
        modifiedAtMs: sql<number>`coalesce(${mediaSources.modifiedAtMs}, 0)`,
      })
      .from(downloadGrants)
      .innerJoin(users, eq(users.id, downloadGrants.userId))
      .innerJoin(
        devices,
        and(eq(devices.id, downloadGrants.deviceId), eq(devices.userId, downloadGrants.userId)),
      )
      .innerJoin(tracks, eq(tracks.id, downloadGrants.trackId))
      .innerJoin(mediaSources, eq(mediaSources.id, tracks.sourceId))
      .innerJoin(libraryRoots, eq(libraryRoots.id, mediaSources.rootId))
      .leftJoin(mediaSourceAvailability, eq(mediaSourceAvailability.sourceId, mediaSources.id))
      .where(
        and(
          sql`coalesce(${mediaSourceAvailability.isAvailable}, 1) = 1`,
          eq(downloadGrants.tokenHash, hashToken(grantToken)),
          eq(downloadGrants.trackId, trackId),
          isNull(downloadGrants.revokedAtMs),
          gt(downloadGrants.expiresAtMs, nowMs),
          isNull(devices.revokedAtMs),
          eq(users.isActive, true),
          or(eq(users.canDownload, true), eq(users.role, "admin")),
        ),
      )
      .get();
    if (row == null || row.size == null)
      return yield* notFound("Playback grant is invalid or expired");
    const principal = {
      user: { ...row.user, role: row.user.role as "admin" | "user" },
      sessionId: row.id,
      deviceId: row.deviceId,
    } satisfies AuthPrincipal;
    yield* access
      .requireTrack(principal, trackId, "playback:control", nowMs)
      .pipe(Effect.mapError(() => notFound("Playback grant is invalid or expired")));
    const [root, file] = yield* Effect.all([
      Effect.promise(() => canonicalPath(row.rootPath)),
      Effect.promise(() => canonicalPath(row.absolutePath)),
    ]);
    if (!isPathWithin(root, file)) return yield* notFound("Playback grant is invalid or expired");
    return {
      absolutePath: file,
      size: row.size,
      modifiedAtMs: row.modifiedAtMs,
      mimeType: mediaType(file) ?? "application/octet-stream",
      sessionId: `download:${row.id}`,
      userId: row.user.id,
    } satisfies AuthorizedMedia;
  });

  return { issue, revoke, sync, authorize };
});
