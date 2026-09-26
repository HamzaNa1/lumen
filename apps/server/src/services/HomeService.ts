import type { HomeContent, IpcItem, IpcLibrary } from "@lumen/contracts";
import { Database, libraries, libraryProfiles } from "@lumen/database";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";
import { homeCardColumns, homeItems, latestEpisodesQuery, nextUpQuery } from "./HomeQueries";

export interface HomeServiceShape {
  readonly content: (
    principal: AuthPrincipal,
    nowMs: number,
  ) => Effect.Effect<HomeContent, unknown>;
}

export const makeHomeService = Effect.gen(function* () {
  const db = yield* Database;
  const access = yield* AccessControl;
  const content: HomeServiceShape["content"] = Effect.fn("Home.content")(
    function* (principal, nowMs) {
      const libraryIds = yield* access.accessibleLibraryIds(principal, nowMs);
      const result: HomeContent = {
        libraryCount: libraryIds.length,
        libraries: [],
        continueWatching: [],
        continueListening: [],
        nextUp: [],
        latest: [],
      };
      if (libraryIds.length === 0) return result;
      const accessibleLibraries = yield* db
        .select({
          id: libraries.id,
          name: libraries.name,
          slug: libraries.slug,
          kind: sql<IpcLibrary["kind"]>`coalesce(${libraryProfiles.kind}, 'movies')`,
          isEnabled: libraries.isEnabled,
          createdAtMs: libraries.createdAtMs,
          updatedAtMs: libraries.updatedAtMs,
        })
        .from(libraries)
        .leftJoin(libraryProfiles, eq(libraryProfiles.libraryId, libraries.id))
        .where(inArray(libraries.id, libraryIds))
        .orderBy(asc(libraries.name), asc(libraries.id));
      const latest: HomeContent["latest"][number][] = [];
      const resume = (audio: boolean) =>
        db.all<IpcItem>(sql`
      WITH items AS (${homeItems(principal.user.id, libraryIds)})
      SELECT ${homeCardColumns} FROM items
      WHERE available = 1 AND completed = 0 AND resumePositionSeconds > 0
        AND ${audio ? sql`kind = 'track'` : sql`kind IN ('movie', 'episode')`}
      ORDER BY activity DESC, id DESC LIMIT 12
    `);
      const continueWatching = yield* resume(false);
      const continueListening = yield* resume(true);
      const nextUp = yield* db.all<IpcItem>(
        nextUpQuery(principal.user.id, libraryIds, nowMs - 365 * 86400000),
      );
      for (const library of accessibleLibraries) {
        const items = yield* db.all<IpcItem>(
          library.kind === "shows"
            ? latestEpisodesQuery(principal.user.id, library.id)
            : sql`
        WITH items AS (${homeItems(principal.user.id, [library.id])})
        SELECT ${homeCardColumns} FROM items
        WHERE available = 1 AND kind IN ('movie', 'track') AND (kind = 'track' OR completed = 0)
        ORDER BY addedAtMs DESC, id DESC LIMIT ${library.kind === "music" ? 30 : 16}
      `,
        );
        if (items.length > 0)
          latest.push({ libraryId: library.id, libraryName: library.name, items });
      }
      return {
        ...result,
        libraries: accessibleLibraries,
        latest,
        continueWatching,
        continueListening,
        nextUp,
      };
    },
  );
  return { content };
});

export class HomeService extends Context.Service<HomeService, HomeServiceShape>()(
  "@lumen/server/HomeService",
) {}
export const HomeServiceLive = Layer.effect(HomeService, makeHomeService);
