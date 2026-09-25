import { Database, serverEventLog } from "@lumen/database";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

const Event = Schema.Struct({
  id: Schema.Int,
  createdAtMs: Schema.Int,
  topic: Schema.String,
  userId: Schema.NullOr(Schema.String),
  payloadJson: Schema.String,
});
type Event = Schema.Schema.Type<typeof Event>;

export interface EventServiceShape {
  readonly publish: (
    topic: string,
    userId: string | null,
    payload: unknown,
  ) => Effect.Effect<number, unknown>;
  readonly read: (
    after: number,
    userId: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Event>, unknown>;
  readonly stream: (
    after: number,
    userId: string,
    signal: AbortSignal,
  ) => ReadableStream<Uint8Array>;
}

export const makeEventService = Effect.gen(function* () {
  const database = yield* Database;
  const publish: EventServiceShape["publish"] = Effect.fn("Events.publish")(
    function* (topic, userId, payload) {
      const payloadJson = JSON.stringify(payload);
      const [row] = yield* database
        .insert(serverEventLog)
        .values({
          createdAtMs: Date.now(),
          topic,
          userId,
          payloadJson,
        })
        .returning({ id: serverEventLog.id });
      return row?.id ?? 0;
    },
  );
  const read: EventServiceShape["read"] = Effect.fn("Events.read")(
    function* (after, userId, limit) {
      const rows = yield* database
        .select()
        .from(serverEventLog)
        .where(
          and(
            gt(serverEventLog.id, after),
            or(isNull(serverEventLog.userId), eq(serverEventLog.userId, userId)),
          ),
        )
        .orderBy(asc(serverEventLog.id))
        .limit(Math.min(100, Math.max(1, limit)));
      return yield* Effect.forEach(rows, (row) =>
        Effect.succeed(Schema.decodeUnknownSync(Event)(row)),
      );
    },
  );
  const stream = (
    after: number,
    userId: string,
    signal: AbortSignal,
  ): ReadableStream<Uint8Array> => {
    let cursor = after;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = async (): Promise<void> => {
          if (signal.aborted) {
            controller.close();
            return;
          }
          const rows = await Effect.runPromise(
            read(cursor, userId, 100).pipe(Effect.catch(() => Effect.succeed([]))),
          );
          for (const row of rows) {
            cursor = row.id;
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${row.id}\nevent: ${row.topic}\ndata: ${row.payloadJson}\n\n`,
              ),
            );
          }
          if (!signal.aborted) timer = setTimeout(() => void send(), 15_000);
        };
        void send();
      },
      cancel: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    });
  };
  return { publish, read, stream };
});

export class EventService extends Context.Service<EventService, EventServiceShape>()(
  "@lumen/server/Events",
) {}
export const EventServiceLive = Layer.effect(EventService, makeEventService);
