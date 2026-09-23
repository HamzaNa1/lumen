import { Context, Effect, Layer } from "effect";
import { Database, type DatabaseClient } from "./Database";
import {
  type ActivityRepository,
  type AuthRepository,
  type CatalogRepository,
  type LibraryRepository,
  makeActivityRepository,
  makeAuthRepository,
  makeCatalogRepository,
  makeLibraryRepository,
  makeScanningRepository,
  makeSearchRepository,
  type ScanningRepository,
  type SearchRepository,
} from "./index";

export interface DatabaseRepositories {
  readonly auth: AuthRepository;
  readonly libraries: LibraryRepository;
  readonly catalog: CatalogRepository;
  readonly activity: ActivityRepository;
  readonly scanning: ScanningRepository;
  readonly search: SearchRepository;
}

export const makeDatabaseRepositories = Effect.fn("Repositories.make")((database: DatabaseClient) =>
  Effect.succeed({
    auth: makeAuthRepository(database),
    libraries: makeLibraryRepository(database),
    catalog: makeCatalogRepository(database),
    activity: makeActivityRepository(database),
    scanning: makeScanningRepository(database),
    search: makeSearchRepository(database),
  }),
);

export class Repositories extends Context.Service<Repositories, DatabaseRepositories>()(
  "@lumen/database/Repositories",
) {}

export const RepositoriesLive = <E, R>(
  databaseLayer: Layer.Layer<Database, E, R>,
): Layer.Layer<Repositories, E, R> =>
  Layer.effect(
    Repositories,
    Effect.gen(function* () {
      const database = yield* Database;
      return yield* makeDatabaseRepositories(database);
    }),
  ).pipe(Layer.provide(databaseLayer));
