import { Database, RepositoriesLive } from "@lumen/database";
import { Effect, Fiber, Layer } from "effect";
import { makeServerConfig } from "./config/ServerConfig";
import type { ServerConfig } from "./config/Config";
import { makeDatabaseLayers } from "./database/DatabaseLayer";
import { ServerIdentityLive, ServerIdentityService, type ServerIdentity } from "./database/Identity";
import { JobService, JobServiceLiveWithConfig, type JobServiceShape } from "./jobs/JobService";
import { FfprobeLive } from "./media/Ffprobe";
import { MediaIngestLive } from "./media/MediaIngest";
import { AccessControl, AccessControlLive } from "./services/AccessControl";
import { AssetService, AssetServiceLive } from "./services/AssetService";
import { AdminService, AdminServiceLive } from "./services/AdminService";
import { AuthService, AuthServiceLive } from "./services/AuthService";
import { CatalogService, CatalogServiceLive } from "./services/CatalogService";
import { EventService, EventServiceLive } from "./services/EventService";
import { LibraryService, LibraryServiceLive } from "./services/LibraryService";
import { ScanService, ScanServiceLive } from "./services/ScanService";
import { PlaybackService, PlaybackServiceLive } from "./services/PlaybackService";
import { ScannerLive } from "./services/Scanner";
import { makeHttpHandler, type HttpServices } from "./http/HttpApp";
import { sql } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ServerServices {
  readonly auth: AuthService["Service"];
  readonly access: AccessControl["Service"];
  readonly admin: AdminService["Service"];
  readonly catalog: CatalogService["Service"];
  readonly events: EventService["Service"];
  readonly libraries: LibraryService["Service"];
  readonly scans: ScanService["Service"];
  readonly assets: AssetService["Service"];
  readonly playback: PlaybackService["Service"];
  readonly jobs: JobServiceShape;
  readonly database: Database["Service"];
  readonly identity: ServerIdentity;
}

export const makeLayers = (config: ServerConfig) => {
  const database = makeDatabaseLayers(config);
  const repositories = RepositoriesLive(database);
  const dependencies = Layer.mergeAll(database, repositories);
  const access = AccessControlLive.pipe(Layer.provide(dependencies));
  const auth = AuthServiceLive.pipe(Layer.provide(dependencies));
  const libraries = LibraryServiceLive.pipe(Layer.provide(dependencies));
  const scans = ScanServiceLive.pipe(Layer.provide(dependencies));
  const assets = AssetServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const admin = AdminServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const catalog = CatalogServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const playback = PlaybackServiceLive.pipe(Layer.provide(Layer.mergeAll(dependencies, access)));
  const scanner = ScannerLive.pipe(Layer.provide(dependencies));
  const ffprobe = FfprobeLive(config);
  const media = MediaIngestLive.pipe(Layer.provide(Layer.mergeAll(dependencies, ffprobe)));
  const jobs = JobServiceLiveWithConfig(config).pipe(Layer.provide(Layer.mergeAll(dependencies, scanner, media)));
  const events = EventServiceLive.pipe(Layer.provide(dependencies));
  const identity = ServerIdentityLive.pipe(Layer.provide(dependencies));
  return Layer.mergeAll(dependencies, auth, access, assets, admin, catalog, libraries, scans, playback, events, jobs, identity);
};

const makeServices = Effect.gen(function* () {
  const database = yield* Database;
  const identity = yield* ServerIdentityService;
  return {
    auth: yield* AuthService,
    access: yield* AccessControl,
    admin: yield* AdminService,
    catalog: yield* CatalogService,
    events: yield* EventService,
    libraries: yield* LibraryService,
    scans: yield* ScanService,
    assets: yield* AssetService,
    playback: yield* PlaybackService,
    jobs: yield* JobService,
    database,
    identity,
  };
});

export interface RunningServer {
  readonly server: Bun.Server<unknown>;
  readonly stop: () => Promise<void>;
}

export const startServer = async (overrides: Partial<ServerConfig> = {}): Promise<RunningServer> => {
  const config = await yieldConfig(overrides);
  await mkdir(dirname(config.databasePath), { recursive: true });
  await mkdir(config.dataDir, { recursive: true });
  const serviceLayer = makeLayers(config) as unknown as Layer.Layer<ServerServices, unknown, never>;
  let resolveServices: (services: ServerServices) => void = () => undefined;
  const servicesPromise = new Promise<ServerServices>((resolve) => {
    resolveServices = resolve;
  });
  const serviceProgram = makeServices.pipe(
    Effect.flatMap((services) => Effect.sync(() => resolveServices(services)).pipe(Effect.andThen(Effect.never))),
    Effect.provide(serviceLayer),
  ) as Effect.Effect<never, unknown, never>;
  const serviceFiber = Effect.runFork(serviceProgram);
  const services = await Promise.race([
    servicesPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Server services did not initialize")), 30_000)),
  ]);
  const httpServices: HttpServices = {
    auth: services.auth,
    access: services.access,
    admin: services.admin,
    catalog: services.catalog,
    events: services.events,
    libraries: services.libraries,
    scans: services.scans,
    assets: services.assets,
    playback: services.playback,
    identity: services.identity,
    database: services.database,
    startedAtMs: Date.now(),
    databaseReady: async () => {
      try {
        await Effect.runPromise(services.database.get(sql`SELECT 1`));
        return true;
      } catch {
        return false;
      }
    },
  };
  const handler = makeHttpHandler(httpServices, config);
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: handler });
  console.log(`Lumen server listening on ${server.url}`);
  const abort = new AbortController();
  const worker = services.jobs.start(abort.signal);
  let stopping: Promise<void> | null = null;
  const stop = async (): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      abort.abort();
      await server.stop(true);
      await worker;
      await Effect.runPromise(Fiber.interrupt(serviceFiber));
    })();
    return stopping;
  };
  return { server, stop };
};

const yieldConfig = async (overrides: Partial<ServerConfig>): Promise<ServerConfig> => {
  const base = await Effect.runPromise(makeServerConfig(overrides));
  return base;
};

if (import.meta.main) {
  const running = await startServer();
  const shutdown = async (): Promise<void> => {
    await running.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
