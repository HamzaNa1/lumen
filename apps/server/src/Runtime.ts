import { WatchGroups, type WatchSocketData } from "./watch-groups/WatchGroups";
import { createLogger, ServerLogger, type Logger } from "./core/Logger";
import { Database, RepositoriesLive, serverIdentity } from "@lumen/database";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { makeServerConfig } from "./config/ServerConfig";
import type { ServerConfig } from "./config/Config";
import { makeDatabaseLayers } from "./database/DatabaseLayer";
import {
  ServerIdentityLive,
  ServerIdentityService,
  type ServerIdentity,
} from "./database/Identity";
import { JobService, JobServiceLiveWithConfig, type JobServiceShape } from "./jobs/JobService";
import { LibraryWatcherLive } from "./jobs/LibraryWatcher";
import {
  ScheduledJobService,
  ScheduledJobServiceLiveWithConfig,
  type ScheduledJobServiceShape,
} from "./jobs/ScheduledJobService";
import { FfprobeLive } from "./media/Ffprobe";
import { MediaIngestLive } from "./media/MediaIngest";
import { TmdbProvider, TmdbProviderLive } from "./media/Tmdb";
import { AccessControl, AccessControlLive } from "./services/AccessControl";
import { AssetService, AssetServiceLiveWithConfig } from "./services/AssetService";
import { AdminService, AdminServiceLive } from "./services/AdminService";
import { AuthService, AuthServiceLive } from "./services/AuthService";
import { CatalogService, CatalogServiceLive } from "./services/CatalogService";
import { HomeService, HomeServiceLive } from "./services/HomeService";
import { EventService, EventServiceLive } from "./services/EventService";
import { LibraryService, LibraryServiceLive } from "./services/LibraryService";
import { ScanService, ScanServiceLive } from "./services/ScanService";
import { PlaybackService, PlaybackServiceLive } from "./services/PlaybackService";
import { ScannerLive } from "./services/Scanner";
import {
  MetadataSettings,
  MetadataSettingsLive,
  type MetadataSettingsShape,
} from "./services/MetadataSettings";
import { ServerName, ServerNameLive, type ServerNameShape } from "./services/ServerName";
import { isTrustedOrigin } from "./http/BrowserSession";
import { makeHttpHandler, type HttpServices } from "./http/HttpApp";
import { assertWebBuild, isWebPath, makeStaticWebHandler } from "./http/StaticWeb";
import { sql } from "drizzle-orm";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ServerServices {
  readonly auth: AuthService["Service"];
  readonly access: AccessControl["Service"];
  readonly admin: AdminService["Service"];
  readonly catalog: CatalogService["Service"];
  readonly home: HomeService["Service"];
  readonly events: EventService["Service"];
  readonly libraries: LibraryService["Service"];
  readonly scans: ScanService["Service"];
  readonly assets: AssetService["Service"];
  readonly playback: PlaybackService["Service"];
  readonly jobs: JobServiceShape;
  readonly scheduledJobs: ScheduledJobServiceShape;
  readonly database: Database["Service"];
  readonly identity: ServerIdentity;
  readonly serverName: ServerNameShape;
  readonly tmdb: TmdbProvider["Service"];
  readonly metadataSettings: MetadataSettingsShape;
}

export const makeLayers = (
  config: ServerConfig,
  logger: Logger = createLogger({ level: config.logLevel, format: config.logFormat }),
) => {
  const database = makeDatabaseLayers(config);
  const repositories = RepositoriesLive(database);
  const dependencies = Layer.mergeAll(database, repositories);
  const access = AccessControlLive.pipe(Layer.provide(dependencies));
  const auth = AuthServiceLive.pipe(Layer.provide(dependencies));
  const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
  const scans = ScanServiceLive.pipe(Layer.provide(dependencies));
  const assets = AssetServiceLiveWithConfig(config).pipe(
    Layer.provide(Layer.mergeAll(dependencies, access)),
  );
  const admin = AdminServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const catalog = CatalogServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const home = HomeServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const playback = PlaybackServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const scanner = ScannerLive.pipe(Layer.provide(dependencies));
  const metadataSettings = MetadataSettingsLive.pipe(Layer.provide(dependencies));
  const ffprobe = FfprobeLive(config);
  const media = MediaIngestLive.pipe(Layer.provide(Layer.mergeAll(dependencies, ffprobe)));
  const tmdb = TmdbProviderLive(config).pipe(
    Layer.provide(Layer.mergeAll(dependencies, metadataSettings)),
  );
  const libraryWatcher = LibraryWatcherLive.pipe(
    Layer.provide(Layer.mergeAll(dependencies, libraries)),
  );
  const jobs = JobServiceLiveWithConfig(config).pipe(
    Layer.provide(
      Layer.mergeAll(dependencies, scanner, media, tmdb, metadataSettings, libraryWatcher),
    ),
  );
  const scheduledJobs = ScheduledJobServiceLiveWithConfig(config).pipe(Layer.provide(dependencies));
  const events = EventServiceLive.pipe(Layer.provide(dependencies));
  const identity = ServerIdentityLive.pipe(Layer.provide(dependencies));
  const serverName = ServerNameLive.pipe(Layer.provide(Layer.mergeAll(dependencies, identity)));
  return Layer.mergeAll(
    dependencies,
    auth,
    access,
    assets,
    admin,
    catalog,
    home,
    libraries,
    scans,
    playback,
    events,
    jobs,
    scheduledJobs,
    identity,
    serverName,
    metadataSettings,
    tmdb,
  ).pipe(Layer.provide(Layer.succeed(ServerLogger, logger)));
};

const makeServices = Effect.gen(function* () {
  const database = yield* Database;
  const identity = yield* ServerIdentityService;
  return {
    auth: yield* AuthService,
    access: yield* AccessControl,
    admin: yield* AdminService,
    catalog: yield* CatalogService,
    home: yield* HomeService,
    events: yield* EventService,
    libraries: yield* LibraryService,
    scans: yield* ScanService,
    assets: yield* AssetService,
    playback: yield* PlaybackService,
    jobs: yield* JobService,
    scheduledJobs: yield* ScheduledJobService,
    database,
    identity,
    serverName: yield* ServerName,
    metadataSettings: yield* MetadataSettings,
    tmdb: yield* TmdbProvider,
  };
});

export interface RunningServer {
  readonly server: Bun.Server<WatchSocketData>;
  readonly stop: () => Promise<void>;
}

export const startServer = async (
  overrides: Partial<ServerConfig> = {},
  suppliedLogger?: Logger,
): Promise<RunningServer> => {
  let logger = suppliedLogger;
  const startedAt = performance.now();
  try {
    const config = await yieldConfig(overrides);
    logger ??= createLogger({ level: config.logLevel, format: config.logFormat });
    logger.info("server_starting");
    return await startConfiguredServer(config, logger, startedAt);
  } catch (cause) {
    (logger ?? createLogger()).error("server_start_failed", {}, cause);
    throw cause;
  }
};

const startConfiguredServer = async (
  config: ServerConfig,
  logger: Logger,
  startedAt: number,
): Promise<RunningServer> => {
  if (config.webApp === "required") await assertWebBuild(config.webRoot);
  await mkdir(dirname(config.databasePath), { recursive: true });
  await mkdir(config.dataDir, { recursive: true });
  const serviceLayer = makeLayers(config, logger) as unknown as Layer.Layer<
    ServerServices,
    unknown,
    never
  >;
  let resolveServices: (services: ServerServices) => void = () => undefined;
  let rejectServices: (cause: unknown) => void = () => undefined;
  const servicesPromise = new Promise<ServerServices>((resolve, reject) => {
    resolveServices = resolve;
    rejectServices = reject;
  });
  const serviceProgram = makeServices.pipe(
    Effect.flatMap((services) =>
      Effect.sync(() => resolveServices(services)).pipe(Effect.andThen(Effect.never)),
    ),
    Effect.provide(serviceLayer),
  ) as Effect.Effect<never, unknown, never>;
  const serviceFiber = Effect.runFork(serviceProgram);
  serviceFiber.addObserver((exit) => {
    if (Exit.isFailure(exit)) rejectServices(Cause.squash(exit.cause));
  });
  let startupTimeout: ReturnType<typeof setTimeout> | undefined;
  let server: Bun.Server<WatchSocketData> | undefined;
  try {
    const services = await Promise.race([
      servicesPromise,
      new Promise<never>((_, reject) => {
        startupTimeout = setTimeout(
          () => reject(new Error("Server services did not initialize")),
          30_000,
        );
      }),
    ]);
    clearTimeout(startupTimeout);
    for (const path of [
      config.databasePath,
      `${config.databasePath}-wal`,
      `${config.databasePath}-shm`,
    ]) {
      try {
        await chmod(path, 0o600);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    const httpServices: HttpServices = {
      auth: services.auth,
      access: services.access,
      admin: services.admin,
      catalog: services.catalog,
      home: services.home,
      events: services.events,
      libraries: services.libraries,
      scans: services.scans,
      assets: services.assets,
      playback: services.playback,
      jobs: services.jobs,
      identity: services.identity,
      serverName: services.serverName,
      metadataSettings: services.metadataSettings,
      tmdb: services.tmdb,
      startedAtMs: Date.now(),
      databaseReady: async () => {
        try {
          await Effect.runPromise(
            services.database.select({ ready: sql<number>`1` }).from(serverIdentity).limit(1),
          );
          return true;
        } catch {
          return false;
        }
      },
    };
    const handler = makeHttpHandler(httpServices, config, logger);
    const web = makeStaticWebHandler(config, logger);
    const watchGroups = new WatchGroups(httpServices, (request, origin) =>
      isTrustedOrigin(request, origin, config),
      { logger: logger.child({ component: "watch-groups" }) },
    );
    const listeningServer = Bun.serve<WatchSocketData>({
      hostname: config.host,
      port: config.port,
      fetch: (request, server) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/v1/watch-groups") return watchGroups.upgrade(request, server);
        // The app's files are matched by prefix before the API sees the request, and the API
        // owns every other path, so neither can answer for the other.
        const context = {
          peerAddress: server.requestIP(request)?.address ?? null,
          disableIdleTimeout: () => server.timeout(request, 0),
        };
        return isWebPath(pathname) ? web(request, context) : handler(request, context);
      },
      websocket: watchGroups.websocket,
    });
    server = listeningServer;
    logger.info("server_listening", {
      host: config.host,
      port: listeningServer.port,
      durationMs: Math.round(performance.now() - startedAt),
    });
    const abort = new AbortController();
    const worker = services.jobs.start(abort.signal);
    const scheduler = services.scheduledJobs.start(abort.signal);
    let stopping: Promise<void> | null = null;
    const stop = async (): Promise<void> => {
      if (stopping !== null) return stopping;
      stopping = (async () => {
        const shutdownStartedAt = performance.now();
        logger.info("server_stopping");
        abort.abort();
        watchGroups.close();
        try {
          const outcomes = await Promise.allSettled([
            listeningServer.stop(true),
            worker,
            scheduler,
          ]);
          const failure = outcomes.find((outcome) => outcome.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        } catch (cause) {
          logger.error("server_stop_failed", {}, cause);
          throw cause;
        } finally {
          await Effect.runPromise(Fiber.interrupt(serviceFiber));
        }
        logger.info("server_stopped", {
          durationMs: Math.round(performance.now() - shutdownStartedAt),
        });
      })();
      return stopping;
    };
    // Observe rejection immediately, including before anyone calls stop().
    for (const [component, task] of [
      ["worker", worker],
      ["scheduler", scheduler],
    ] as const) {
      void task.catch((cause: unknown) => {
        logger.error("background_service_failed", { component }, cause);
        void stop().catch(() => undefined);
      });
    }
    return { server: listeningServer, stop };
  } catch (cause) {
    await server?.stop(true);
    await Effect.runPromise(Fiber.interrupt(serviceFiber));
    throw cause;
  } finally {
    clearTimeout(startupTimeout);
  }
};

const yieldConfig = async (overrides: Partial<ServerConfig>): Promise<ServerConfig> => {
  const base = await Effect.runPromise(makeServerConfig(overrides));
  return base;
};

export const runServer = async (): Promise<void> => {
  try {
    const running = await startServer();
    const shutdown = (): void => {
      void running.stop().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.exitCode = 1;
  }
};

if (import.meta.main) await runServer();
