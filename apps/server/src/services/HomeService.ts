import {
  defaultHomePreferences,
  HomePreferences,
  type HomeContent,
  type IpcItem,
  type IpcLibrary,
} from "@lumen/contracts";
import { Database, libraries, libraryProfiles, userHomePreferences } from "@lumen/database";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";
import { homeCardColumns, homeItems, latestEpisodesQuery, nextUpQuery } from "./HomeQueries";

export interface HomeServiceShape {
  readonly content: (
    principal: AuthPrincipal,
    nowMs: number,
  ) => Effect.Effect<HomeContent, unknown>;
  readonly preferences: (userId: string) => Effect.Effect<HomePreferences, unknown>;
  readonly savePreferences: (
    userId: string,
    preferences: HomePreferences,
    nowMs: number,
  ) => Effect.Effect<HomePreferences, unknown>;
}

export const makeHomeService = Effect.gen(function* () {
  const db = yield* Database;
  const access = yield* AccessControl;
  const preferences: HomeServiceShape["preferences"] = Effect.fn("Home.preferences")(
    function* (userId) {
      const row = yield* db
        .select()
        .from(userHomePreferences)
        .where(eq(userHomePreferences.userId, userId))
        .get();
      return row == null
        ? defaultHomePreferences
        : Schema.decodeUnknownSync(HomePreferences)(JSON.parse(row.preferencesJson));
    },
  );
  const savePreferences: HomeServiceShape["savePreferences"] = Effect.fn("Home.savePreferences")(
    function* (userId, value, nowMs) {
      const values = { preferencesJson: JSON.stringify(value), updatedAtMs: nowMs };
      yield* db
        .insert(userHomePreferences)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: userHomePreferences.userId, set: values });
      return value;
    },
  );
  const content: HomeServiceShape["content"] = Effect.fn("Home.content")(
    function* (principal, nowMs) {
      const settings = yield* preferences(principal.user.id);
      const libraryIds = yield* access.accessibleLibraryIds(principal, nowMs);
      const result: HomeContent = {
        preferences: settings,
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
      const order = new Map(settings.libraryOrder.map((id, index) => [id, index]));
      const visibleLibraries = accessibleLibraries
        .filter((library) => !settings.hiddenLibraries.includes(library.id))
        .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
      const contentLibraryIds = libraryIds.filter((id) => !settings.excludedLibraries.includes(id));
      const latest: HomeContent["latest"][number][] = [];
      const resume = (audio: boolean) =>
        db.all<IpcItem>(sql`
      WITH items AS (${homeItems(principal.user.id, contentLibraryIds)})
      SELECT ${homeCardColumns} FROM items
      WHERE available = 1 AND completed = 0 AND resumePositionSeconds > 0
        AND ${audio ? sql`kind = 'track'` : sql`kind IN ('movie', 'episode')`}
      ORDER BY activity DESC, id DESC LIMIT 12
    `);
      const enabled = (section: HomePreferences["sections"][number]) =>
        contentLibraryIds.length > 0 && settings.sections.includes(section);
      const continueWatching = enabled("resume-video") ? yield* resume(false) : [];
      const continueListening = enabled("resume-audio") ? yield* resume(true) : [];
      const nextUp = enabled("next-up")
        ? yield* db.all<IpcItem>(
            nextUpQuery(
              principal.user.id,
              contentLibraryIds,
              nowMs - settings.nextUpDays * 86400000,
            ),
          )
        : [];
      for (const library of visibleLibraries) {
        if (!enabled("latest") || settings.excludedLibraries.includes(library.id)) continue;
        const items = yield* db.all<IpcItem>(
          library.kind === "shows"
            ? latestEpisodesQuery(principal.user.id, library.id, settings.hideWatched)
            : sql`
        WITH items AS (${homeItems(principal.user.id, [library.id])})
        SELECT ${homeCardColumns} FROM items
        WHERE available = 1 AND kind IN ('movie', 'track') AND (kind = 'track' OR completed = 0 OR ${!settings.hideWatched})
        ORDER BY addedAtMs DESC, id DESC LIMIT ${library.kind === "music" ? 30 : 16}
      `,
        );
        if (items.length > 0)
          latest.push({ libraryId: library.id, libraryName: library.name, items });
      }
      return {
        ...result,
        libraries: visibleLibraries,
        latest,
        continueWatching,
        continueListening,
        nextUp,
      };
    },
  );
  return { content, preferences, savePreferences };
});

export class HomeService extends Context.Service<HomeService, HomeServiceShape>()(
  "@lumen/server/HomeService",
) {}
export const HomeServiceLive = Layer.effect(HomeService, makeHomeService);
