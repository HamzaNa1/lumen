import { Effect } from "effect";
import { notFound, ServerError } from "../core/Errors";
import type { MediaToolkit } from "../http/MountedRouter";
import type { AssetServiceShape } from "../services/AssetService";
import type { AuthPrincipal } from "../services/AuthService";
import type { CatalogServiceShape } from "../services/CatalogService";
import type { HomeServiceShape } from "../services/HomeService";
import { fromJellyfinId, requireId } from "./Ids";
import { baseItem, type ItemContext, mediaSourceInfo, userData, viewItem } from "./Items";
import {
  ALL_ITEMS,
  type ItemQuery,
  type ItemRow,
  type Kind,
  type Queries,
  type SortBy,
  VIDEO_KINDS,
} from "./Queries";
import type { BaseItemDto, QueryResult } from "./Schemas";

const call = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

export interface BrowseContext {
  readonly request: Request;
  readonly query: (name: string) => string | null;
  readonly principal: AuthPrincipal;
}

const kindsByType: Record<string, Kind> = {
  movie: "movie",
  series: "show",
  season: "season",
  episode: "episode",
};

const sorts: Record<string, SortBy> = {
  sortname: "SortName",
  name: "SortName",
  default: "SortName",
  datecreated: "DateCreated",
  premieredate: "PremiereDate",
  productionyear: "PremiereDate",
  dateplayed: "DatePlayed",
  datelastcontentadded: "Latest",
};

const split = (value: string | null): ReadonlyArray<string> =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

/** The most items one request returns; the total still counts them all, so apps can page. */
export const MAX_PAGE = 500;

const integer = (value: string | null, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value ?? "");
  return value === null || value === "" || !Number.isSafeInteger(parsed) || parsed < 0
    ? fallback
    : Math.min(parsed, maximum);
};

const flag = (value: string | null): boolean | null =>
  value === null || value === "" ? null : value.toLowerCase() === "true";

/** The item types a request names, out of those Lumen has; all of them when it names none. */
const kindsOf = (context: BrowseContext, fallback: ReadonlyArray<Kind>): ReadonlyArray<Kind> => {
  const included = split(context.query("includeItemTypes"));
  const excluded = new Set(
    split(context.query("excludeItemTypes")).map((type) => kindsByType[type.toLowerCase()]),
  );
  const kinds =
    included.length === 0
      ? fallback
      : included.flatMap((type) => kindsByType[type.toLowerCase()] ?? []);
  return [...new Set(kinds)].filter((kind) => !excluded.has(kind));
};

export const makeBrowse = (dependencies: {
  readonly queries: Queries;
  readonly catalog: CatalogServiceShape;
  readonly home: HomeServiceShape;
  readonly assets: AssetServiceShape;
  readonly media: MediaToolkit;
  readonly serverId: () => string;
}) => {
  const { queries, catalog, home, assets, media } = dependencies;
  const itemContext = (principal: AuthPrincipal): ItemContext => ({
    serverId: dependencies.serverId(),
    canDownload: principal.user.canDownload === true,
  });

  const withSources = async (
    rows: ReadonlyArray<ItemRow>,
    context: ItemContext,
    include: boolean,
  ): Promise<ReadonlyArray<BaseItemDto>> =>
    Promise.all(
      rows.map(async (row) => {
        if (!include || (row.kind !== "movie" && row.kind !== "episode"))
          return baseItem(row, context);
        const source = await call(queries.source(row.id));
        return baseItem(
          row,
          context,
          source === null ? [] : [mediaSourceInfo(row.id, row.title, source)],
        );
      }),
    );

  const result = async (
    context: BrowseContext,
    found: { rows: ReadonlyArray<ItemRow>; total: number },
    startIndex: number,
  ): Promise<QueryResult<BaseItemDto>> => {
    const fields = new Set(split(context.query("fields")).map((field) => field.toLowerCase()));
    return {
      Items: await withSources(
        found.rows,
        itemContext(context.principal),
        fields.has("mediasources") || fields.has("mediastreams"),
      ),
      TotalRecordCount: found.total,
      StartIndex: startIndex,
    };
  };

  const query = (context: BrowseContext, overrides: Partial<ItemQuery> = {}): ItemQuery => {
    const filters = new Set(split(context.query("filters")).map((name) => name.toLowerCase()));
    const sortBy = split(context.query("sortBy"))
      .map((name) => sorts[name.toLowerCase()])
      .find((sort) => sort !== undefined);
    const parent = context.query("parentId");
    const ids = split(context.query("ids"));
    return {
      parentId: parent === null || parent === "" ? null : requireId(parent, "ParentId"),
      recursive: flag(context.query("recursive")) ?? false,
      kinds: kindsOf(context, VIDEO_KINDS),
      ids: ids.length === 0 ? null : ids.flatMap((id) => fromJellyfinId(id) ?? []),
      search: context.query("searchTerm")?.trim() || null,
      favorite: filters.has("isfavorite") ? true : flag(context.query("isFavorite")),
      played: filters.has("isplayed")
        ? true
        : filters.has("isunplayed")
          ? false
          : flag(context.query("isPlayed")),
      resumable: filters.has("isresumable"),
      sortBy: sortBy ?? "SortName",
      descending: split(context.query("sortOrder"))[0]?.toLowerCase() === "descending",
      startIndex: integer(context.query("startIndex"), 0),
      limit: integer(context.query("limit"), MAX_PAGE, MAX_PAGE),
      ...overrides,
    };
  };

  const list = async (context: BrowseContext, overrides: Partial<ItemQuery> = {}) => {
    const request = query(context, overrides);
    const found = await call(queries.items(context.principal, request, Date.now()));
    return result(context, found, request.startIndex);
  };

  const views = async (context: BrowseContext): Promise<QueryResult<BaseItemDto>> => {
    const found = await call(queries.views(context.principal, Date.now()));
    return {
      Items: found.map((view) => viewItem(view, dependencies.serverId())),
      TotalRecordCount: found.length,
      StartIndex: 0,
    };
  };

  const item = async (context: BrowseContext, id: string): Promise<BaseItemDto> => {
    const view = (await call(queries.views(context.principal, Date.now()))).find(
      (candidate) => candidate.id === id,
    );
    if (view !== undefined) return viewItem(view, dependencies.serverId());
    const row = await call(queries.item(context.principal, id, Date.now()));
    if (row === null) throw notFound("Item not found");
    const [found] = await withSources([row], itemContext(context.principal), true);
    if (found === undefined) throw notFound("Item not found");
    return found;
  };

  const seasons = (context: BrowseContext, showId: string) =>
    list(context, { parentId: showId, recursive: false, kinds: ["season"], sortBy: "SortName" });

  const episodes = (context: BrowseContext, showId: string) => {
    const seasonId = fromJellyfinId(context.query("seasonId"));
    const season = context.query("season");
    return list(context, {
      parentId: seasonId ?? showId,
      recursive: seasonId === null,
      kinds: ["episode"],
      seasonNumber: season === null ? null : integer(season, -1),
    });
  };

  const byIds = async (context: BrowseContext, ids: ReadonlyArray<string>) => {
    if (ids.length === 0) return [];
    const found = await call(queries.items(context.principal, { ...ALL_ITEMS, ids }, Date.now()));
    const byId = new Map(found.rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  };

  const nextUp = async (context: BrowseContext): Promise<QueryResult<BaseItemDto>> => {
    const seriesId = fromJellyfinId(context.query("seriesId"));
    let ids: ReadonlyArray<string>;
    if (seriesId !== null) {
      const next = await call(catalog.nextUp(context.principal, seriesId, Date.now())).catch(
        (cause: unknown) => {
          if (cause instanceof ServerError && cause.status < 500) return { item: null };
          throw cause;
        },
      );
      const item = next.item as { readonly id: string } | null;
      ids = item === null ? [] : [item.id];
    } else {
      const content = await call(home.content(context.principal, Date.now()));
      ids = content.nextUp.map((entry) => entry.id);
    }
    const startIndex = integer(context.query("startIndex"), 0);
    const rows = await byIds(context, ids);
    const limit = integer(context.query("limit"), rows.length);
    return result(
      context,
      { rows: rows.slice(startIndex, startIndex + limit), total: rows.length },
      startIndex,
    );
  };

  const resume = (context: BrowseContext) =>
    list(context, {
      kinds: kindsOf(context, ["movie", "episode"]).filter(
        (kind) => kind === "movie" || kind === "episode",
      ),
      recursive: true,
      resumable: true,
      sortBy: "DatePlayed",
      descending: true,
    });

  const latest = async (context: BrowseContext) => {
    const found = await list(context, {
      kinds: kindsOf(context, ["movie", "show"]),
      recursive: true,
      played: flag(context.query("isPlayed")) ?? false,
      sortBy: "Latest",
      descending: true,
      startIndex: 0,
      limit: integer(context.query("limit"), 20, 100),
    });
    return found.Items;
  };

  const setPlayed = async (context: BrowseContext, itemId: string, played: boolean) => {
    const row = await call(queries.item(context.principal, itemId, Date.now()));
    if (row === null) throw notFound("Item not found");
    const state = { positionSeconds: 0, completed: played };
    // A season carries its episodes; a show is marked through its seasons and loose episodes.
    const targets =
      row.kind === "show"
        ? (
            await call(
              queries.items(
                context.principal,
                { ...ALL_ITEMS, parentId: itemId, recursive: false, kinds: ["season", "episode"] },
                Date.now(),
              ),
            )
          ).rows.map((child) => child.id)
        : [itemId];
    for (const target of targets)
      await call(catalog.setItemWatchState(context.principal, target, state, Date.now()));
    const updated = await call(queries.item(context.principal, itemId, Date.now()));
    return userData(updated ?? row);
  };

  const roles: Record<string, ReadonlyArray<string>> = {
    primary: ["poster", "still"],
    backdrop: ["backdrop"],
    thumb: ["still", "backdrop"],
  };

  /**
   * Jellyfin apps load images without credentials, and some without a tag, so an image is served
   * to anyone who names its item. Item IDs are random and only listings to viewers reveal them.
   * A tag that matches the image lets the response be cached for good.
   */
  const image = async (
    request: Request,
    queryOf: (name: string) => string | null,
    principal: () => Promise<AuthPrincipal | null>,
    itemId: string,
    type: string,
    index: string | undefined,
  ) => {
    const wanted = roles[type.toLowerCase()];
    if (wanted === undefined || (index !== undefined && index !== "0"))
      throw notFound("Image not found");
    const artwork = await call(queries.artworkOf(itemId, wanted));
    if (artwork === undefined) throw notFound("Image not found");
    const tag = queryOf("tag");
    const viewer = await principal();
    const asset =
      viewer === null
        ? await call(assets.publicArtwork(artwork.id))
        : await call(assets.artwork(viewer, artwork.id, Date.now())).catch((cause: unknown) => {
            if (cause instanceof ServerError && cause.code === "forbidden")
              throw notFound("Image not found");
            throw cause;
          });
    return media.serveArtwork({
      request,
      asset,
      revision: tag === artwork.contentHash ? tag : null,
      width: queryOf("maxWidth") ?? queryOf("fillWidth") ?? queryOf("width"),
    });
  };

  return { views, list, item, seasons, episodes, nextUp, resume, latest, setPlayed, image };
};
