import { join } from "node:path";
import type { Database } from "@lumen/database";
import { Effect, Schema } from "effect";
import type { ServerConfig } from "../config/Config";
import { badRequest, forbidden, notFound, ServerError } from "../core/Errors";
import type { ServerIdentity } from "../database/Identity";
import type { MountRouter, RequestLabel } from "../http/MountedRouter";
import type { AccessControlShape } from "../services/AccessControl";
import type { AssetServiceShape } from "../services/AssetService";
import type { AuthPrincipal, AuthServiceShape } from "../services/AuthService";
import type { CatalogServiceShape } from "../services/CatalogService";
import type { HomeServiceShape } from "../services/HomeService";
import type { PlaybackServiceShape } from "../services/PlaybackService";
import type { ServerNameShape } from "../services/ServerName";
import type { TranscodingSettingsShape } from "../services/TranscodingSettings";
import { accessToken, authenticate, sessionInfo, signIn, userDto } from "./Auth";
import { makeBrowse } from "./Browse";
import { fromJellyfinId, requireId, toJellyfinId } from "./Ids";
import { makePlayback } from "./Playback";
import { VideoProbe } from "./Probe";
import { makeQueries } from "./Queries";
import { Reporting } from "./Reporting";
import { AuthenticateByName, PlaybackInfoBody, PlaybackReport } from "./Schemas";
import { SubtitleExtractor } from "./Subtitles";

/** The Jellyfin release whose API these routes follow. */
const JELLYFIN_VERSION = "12.4.0";
const PREFIX = /^\/jellyfin(?=\/|$)/iu;

/** Jellyfin's own limit for the payload apps download to measure the connection. */
const BITRATE_TEST_MAX_BYTES = 100_000_000;
// Random bytes, so nothing between the server and the app can compress the measurement away.
const BITRATE_TEST_CHUNK = crypto.getRandomValues(new Uint8Array(64 * 1024));

/** `size` bytes for an app to time, streamed so a large test holds no memory. */
const bitrateTest = (size: number) => {
  let left = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const length = Math.min(left, BITRATE_TEST_CHUNK.length);
      controller.enqueue(BITRATE_TEST_CHUNK.slice(0, length));
      left -= length;
      if (left === 0) controller.close();
    },
  });
};

export interface JellyfinServices {
  readonly auth: AuthServiceShape;
  readonly access: AccessControlShape;
  readonly playback: PlaybackServiceShape;
  readonly catalog: CatalogServiceShape;
  readonly home: HomeServiceShape;
  readonly assets: AssetServiceShape;
  readonly transcodingSettings: TranscodingSettingsShape;
  readonly serverName: ServerNameShape;
  readonly identity: ServerIdentity;
  readonly database: Database["Service"];
}

interface Context {
  readonly request: Request;
  readonly params: Readonly<Record<string, string>>;
  /** Query parameters by name, ignoring case as Jellyfin does; repeated values join with commas. */
  readonly query: (name: string) => string | null;
  readonly principal: () => Promise<AuthPrincipal>;
  readonly body: () => Promise<unknown>;
}

interface Route {
  readonly methods: ReadonlyArray<string>;
  readonly template: string;
  readonly pattern: RegExp;
  readonly label: RequestLabel;
  readonly handle: (context: Context) => Promise<Response>;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const noContent = () => new Response(null, { status: 204 });

const compile = (template: string) =>
  new RegExp(
    `^${template
      .replaceAll(/[.]/gu, "\\.")
      .replaceAll(/\{(\w+)\+\}/gu, "(?<$1>.+)")
      .replaceAll(/\{(\w+)\}/gu, "(?<$1>[^/]+)")}$`,
    "iu",
  );

const decode = <S extends Schema.Decoder<unknown, never>>(schema: S, value: unknown): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(value ?? {});
  } catch (cause) {
    throw badRequest(cause instanceof Error ? cause.message : "Request validation failed");
  }
};

export const makeJellyfinRouter =
  (services: JellyfinServices, config: ServerConfig): MountRouter =>
  (media) => {
    const call = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
    const serverId = toJellyfinId(services.identity.installationId);
    const queries = makeQueries(services.database, services.access);
    const reporting = new Reporting(services.playback, media);
    const browse = makeBrowse({
      queries,
      catalog: services.catalog,
      home: services.home,
      assets: services.assets,
      media,
      serverId: () => serverId,
    });
    const playback = makePlayback({
      playback: services.playback,
      transcodingSettings: services.transcodingSettings,
      queries,
      reporting,
      media,
      probe: new VideoProbe(),
      subtitles: new SubtitleExtractor(
        join(config.dataDir, "jellyfin", "subtitles"),
        media.transcoder,
      ),
    });

    /** A user named in a path or query must be the one signed in. */
    const self = async (context: Context) => {
      const principal = await context.principal();
      const named = context.params.userId ?? context.query("userId");
      if (named !== undefined && named !== null && named !== "")
        if (fromJellyfinId(named) !== principal.user.id) throw forbidden("Another user's data");
      return principal;
    };

    const publicInfo = async () => ({
      ServerName: await call(services.serverName.name()),
      Version: JELLYFIN_VERSION,
      ProductName: "Jellyfin Server",
      OperatingSystem: "",
      Id: serverId,
      StartupWizardCompleted: !(await call(services.auth.setupRequired())),
    });

    const user = async (principal: AuthPrincipal) =>
      userDto(principal.user, {
        serverId,
        serverName: await call(services.serverName.name()),
        playback: services.playback,
        principal,
      });

    const browseContext = async (context: Context) => ({
      request: context.request,
      query: context.query,
      principal: await self(context),
    });

    const report = (kind: "report" | "stopped") => async (context: Context) => {
      const principal = await self(context);
      const body = decode(PlaybackReport, await context.body());
      if (kind === "stopped") await reporting.stopped(principal, body);
      else await reporting.report(principal, body);
      return noContent();
    };

    const definitions: ReadonlyArray<
      readonly [string, string, RequestLabel, (context: Context) => Promise<Response>]
    > = [
      ["GET", "/System/Info/Public", "api", async () => json(await publicInfo())],
      [
        "GET",
        "/System/Info",
        "api",
        async (context) => {
          await context.principal();
          return json({
            ...(await publicInfo()),
            HasPendingRestart: false,
            IsShuttingDown: false,
            SupportsLibraryMonitor: true,
            WebSocketPortNumber: 0,
            CanSelfRestart: false,
            CanLaunchWebBrowser: false,
            HasUpdateAvailable: false,
            CompletedInstallations: [],
          });
        },
      ],
      ["GET,POST", "/System/Ping", "api", async () => json("Jellyfin Server")],
      [
        "GET",
        "/Branding/Configuration",
        "api",
        async () => json({ LoginDisclaimer: "", CustomCss: "", SplashscreenEnabled: false }),
      ],
      [
        "GET",
        "/Branding/Css",
        "api",
        async () => new Response("", { headers: { "content-type": "text/css" } }),
      ],
      [
        "GET",
        "/Branding/Css.css",
        "api",
        async () => new Response("", { headers: { "content-type": "text/css" } }),
      ],
      ["GET", "/QuickConnect/Enabled", "api", async () => json(false)],
      [
        "GET",
        "/Playback/BitrateTest",
        "api",
        async (context) => {
          await context.principal();
          const size = Number(context.query("size") ?? 102_400);
          if (!Number.isSafeInteger(size) || size < 1 || size > BITRATE_TEST_MAX_BYTES)
            throw badRequest(`size must be between 1 and ${BITRATE_TEST_MAX_BYTES}`);
          return new Response(bitrateTest(size), {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(size),
            },
          });
        },
      ],
      ["GET", "/Users/Public", "api", async () => json([])],
      [
        "POST",
        "/Users/AuthenticateByName",
        "login",
        async (context) => {
          const body = decode(AuthenticateByName, await context.body());
          const signedIn = await signIn(services.auth, context.request, {
            username: body.Username,
            password: body.Pw ?? "",
          });
          return json({
            User: await user(signedIn.principal),
            SessionInfo: sessionInfo(signedIn.principal, signedIn.header, serverId, Date.now()),
            AccessToken: signedIn.session.accessToken,
            ServerId: serverId,
          });
        },
      ],
      ["GET", "/Users/Me", "api", async (context) => json(await user(await context.principal()))],
      ["GET", "/Users/{userId}", "api", async (context) => json(await user(await self(context)))],
      [
        "POST",
        "/Sessions/Logout",
        "api",
        async (context) => {
          const principal = await context.principal();
          await call(services.auth.logout(principal, principal.sessionId, Date.now()));
          return noContent();
        },
      ],
      [
        "POST",
        "/Sessions/Capabilities",
        "api",
        async (context) => {
          await context.principal();
          return noContent();
        },
      ],
      [
        "POST",
        "/Sessions/Capabilities/Full",
        "api",
        async (context) => {
          await context.principal();
          return noContent();
        },
      ],
      [
        "GET",
        "/DisplayPreferences/{id}",
        "api",
        async (context) => {
          await self(context);
          return json({
            Id: context.params.id,
            SortBy: "SortName",
            RememberIndexing: false,
            PrimaryImageHeight: 250,
            PrimaryImageWidth: 250,
            CustomPrefs: {},
            ScrollDirection: "Horizontal",
            ShowBackdrop: true,
            RememberSorting: false,
            SortOrder: "Ascending",
            ShowSidebar: false,
            Client: context.query("client") ?? "emby",
          });
        },
      ],
      [
        "POST",
        "/DisplayPreferences/{id}",
        "api",
        async (context) => {
          await self(context);
          return noContent();
        },
      ],
      [
        "GET",
        "/UserViews",
        "api",
        async (context) => json(await browse.views(await browseContext(context))),
      ],
      [
        "GET",
        "/Users/{userId}/Views",
        "api",
        async (context) => json(await browse.views(await browseContext(context))),
      ],
      [
        "GET",
        "/Items",
        "api",
        async (context) => json(await browse.list(await browseContext(context))),
      ],
      [
        "GET",
        "/Users/{userId}/Items",
        "api",
        async (context) => json(await browse.list(await browseContext(context))),
      ],
      [
        "GET",
        "/UserItems/Resume",
        "api",
        async (context) => json(await browse.resume(await browseContext(context))),
      ],
      [
        "GET",
        "/Users/{userId}/Items/Resume",
        "api",
        async (context) => json(await browse.resume(await browseContext(context))),
      ],
      [
        "GET",
        "/Items/Latest",
        "api",
        async (context) => json(await browse.latest(await browseContext(context))),
      ],
      [
        "GET",
        "/Users/{userId}/Items/Latest",
        "api",
        async (context) => json(await browse.latest(await browseContext(context))),
      ],
      [
        "GET",
        "/Shows/NextUp",
        "api",
        async (context) => json(await browse.nextUp(await browseContext(context))),
      ],
      [
        "GET",
        "/Shows/{id}/Seasons",
        "api",
        async (context) =>
          json(await browse.seasons(await browseContext(context), requireId(context.params.id))),
      ],
      [
        "GET",
        "/Shows/{id}/Episodes",
        "api",
        async (context) =>
          json(await browse.episodes(await browseContext(context), requireId(context.params.id))),
      ],
      [
        "GET,POST",
        "/Items/{id}/PlaybackInfo",
        "api",
        async (context) => {
          const principal = await self(context);
          const body = decode(PlaybackInfoBody, await context.body());
          return json(
            await playback.playbackInfo(
              { request: context.request, query: context.query, principal },
              requireId(context.params.id),
              body,
            ),
          );
        },
      ],
      ["GET,HEAD", "/Items/{id}/Images/{type}", "api", async (context) => image(context)],
      ["GET,HEAD", "/Items/{id}/Images/{type}/{index}", "api", async (context) => image(context)],
      [
        "GET",
        "/Items/{id}",
        "api",
        async (context) =>
          json(await browse.item(await browseContext(context), requireId(context.params.id))),
      ],
      [
        "GET",
        "/Users/{userId}/Items/{id}",
        "api",
        async (context) =>
          json(await browse.item(await browseContext(context), requireId(context.params.id))),
      ],
      ["POST,DELETE", "/UserPlayedItems/{id}", "api", async (context) => played(context)],
      [
        "POST,DELETE",
        "/Users/{userId}/PlayedItems/{id}",
        "api",
        async (context) => played(context),
      ],
      ["POST", "/Sessions/Playing", "api", report("report")],
      ["POST", "/Sessions/Playing/Progress", "api", report("report")],
      ["POST", "/Sessions/Playing/Stopped", "api", report("stopped")],
      [
        "POST",
        "/Sessions/Playing/Ping",
        "api",
        async (context) => {
          const principal = await context.principal();
          await reporting.ping(principal, context.query("playSessionId"));
          return noContent();
        },
      ],
      [
        // Jellyfin 12 removed this; apps built for 10.10 still call it when playback stops.
        "DELETE",
        "/Videos/ActiveEncodings",
        "api",
        async (context) => {
          const principal = await context.principal();
          reporting.stopEncoding(principal, fromJellyfinId(context.query("playSessionId")));
          return noContent();
        },
      ],
      ["GET,HEAD", "/Videos/{id}/stream", "media", async (context) => stream(context)],
      ["GET,HEAD", "/Videos/{id}/stream.{container}", "media", async (context) => stream(context)],
      [
        "GET",
        "/Videos/{id}/adaptive/{audioIndex}/{file+}",
        "media",
        async (context) =>
          playback.adaptive(
            await playbackContext(context),
            requireId(context.params.id),
            context.params.audioIndex ?? "",
            context.params.file ?? "",
          ),
      ],
      [
        "GET",
        "/Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.{format}",
        "media",
        async (context) => subtitle(context),
      ],
      [
        "GET",
        "/Videos/{id}/{mediaSourceId}/Subtitles/{index}/{startTicks}/Stream.{format}",
        "media",
        async (context) => subtitle(context),
      ],
    ];

    const playbackContext = async (context: Context) => ({
      request: context.request,
      query: context.query,
      principal: await context.principal(),
    });
    const stream = async (context: Context) =>
      playback.stream(await playbackContext(context), requireId(context.params.id));
    const subtitle = async (context: Context) =>
      playback.subtitle(
        await playbackContext(context),
        requireId(context.params.id),
        context.params.index ?? "",
        context.params.format ?? "",
      );
    const played = async (context: Context) =>
      json(
        await browse.setPlayed(
          await browseContext(context),
          requireId(context.params.id),
          context.request.method === "POST",
        ),
      );
    const image = (context: Context) =>
      browse.image(
        context.request,
        context.query,
        async () =>
          accessToken(context.request, context.query) === null ? null : context.principal(),
        requireId(context.params.id),
        context.params.type ?? "",
        context.params.index,
      );

    const routes: ReadonlyArray<Route> = definitions.map(([methods, template, label, handle]) => ({
      methods: methods.split(","),
      template,
      pattern: compile(template),
      label,
      handle,
    }));

    // What an app asked for that Lumen does not answer, with IDs and numbers masked and the
    // length bounded, so the log shows which Jellyfin features apps reach for.
    const unmatched = (request: Request) =>
      `/unmatched${pathOf(new URL(request.url))
        .replaceAll(/[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}/giu, "{id}")
        .replaceAll(/\d+/gu, "{n}")
        .replaceAll(/[^A-Za-z0-9/{}._-]/gu, "")
        .slice(0, 120)}`;
    const pathOf = (url: URL) =>
      url.pathname.replace(PREFIX, "").replaceAll(/\/{2,}/gu, "/") || "/";
    const match = (request: Request) => {
      const url = new URL(request.url);
      const path = pathOf(url);
      for (const route of routes) {
        if (!route.methods.includes(request.method.toUpperCase())) continue;
        const found = route.pattern.exec(path);
        if (found !== null) return { route, url, params: found.groups ?? {} };
      }
      return null;
    };

    return {
      owns: (url) => PREFIX.test(url.pathname),
      label: (request) => match(request)?.route.label ?? "api",
      route: (request) => `/jellyfin${match(request)?.route.template ?? unmatched(request)}`,
      handle: async (request) => {
        const found = match(request);
        if (found === null) throw notFound("Endpoint not found");
        const parameters = new Map<string, string>();
        for (const [name, value] of found.url.searchParams) {
          const key = name.toLowerCase();
          const existing = parameters.get(key);
          parameters.set(key, existing === undefined ? value : `${existing},${value}`);
        }
        const query = (name: string) => parameters.get(name.toLowerCase()) ?? null;
        let principal: Promise<AuthPrincipal> | undefined;
        const context: Context = {
          request,
          params: found.params,
          query,
          principal: () => {
            principal ??= authenticate(services.auth, request, query);
            return principal;
          },
          body: async () => {
            if (request.method === "GET" || request.method === "HEAD") return {};
            const length = Number(request.headers.get("content-length") ?? 0);
            if (length > config.maxRequestBodyBytes)
              throw new ServerError({
                status: 413,
                code: "payload_too_large",
                message: "Request body is too large",
              });
            const text = await request.text();
            if (text.length > config.maxRequestBodyBytes)
              throw new ServerError({
                status: 413,
                code: "payload_too_large",
                message: "Request body is too large",
              });
            if (text.trim() === "") return {};
            try {
              return JSON.parse(text) as unknown;
            } catch {
              throw badRequest("Request body is not valid JSON");
            }
          },
        };
        return found.route.handle(context);
      },
    };
  };
