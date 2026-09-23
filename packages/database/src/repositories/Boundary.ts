import { Data, Effect, Schema } from "effect";

export class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export const boundary = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  operation: string,
): Effect.Effect<S["Type"], RepositoryError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new RepositoryError({ operation, cause })),
  );

export const guard = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  operation: string,
): Effect.Effect<A, RepositoryError, R> =>
  effect.pipe(Effect.mapError((cause) => new RepositoryError({ operation, cause })));

export const encodeJson = (
  value: unknown,
  operation: string,
): Effect.Effect<string, RepositoryError> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new RepositoryError({ operation, cause }),
  });

export const decodeJson = <S extends Schema.Top>(
  schema: S,
  input: string,
  operation: string,
): Effect.Effect<S["Type"], RepositoryError, S["DecodingServices"]> =>
  Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(input) as unknown,
      catch: (cause) => new RepositoryError({ operation, cause }),
    }),
    (value) => boundary(schema, value, operation),
  );
