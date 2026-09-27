import { Context, Effect, Layer } from "effect";
import { ServerLogger } from "../core/Logger";
import { GroupRegistry } from "../features/watch-groups/GroupRegistry";
import { GroupFailure } from "../features/watch-groups/GroupFailure";
import type { WatchGroupLimits } from "../features/watch-groups/WatchGroupLimits";
import { AccessControl } from "./AccessControl";
import { AuthService } from "./AuthService";
import { PlaybackMedia } from "./PlaybackMedia";
import { PlaybackService } from "./PlaybackService";
export class WatchGroupService extends Context.Service<WatchGroupService, GroupRegistry>()(
  "@lumen/server/WatchGroups",
) {}
export const WatchGroupServiceLive = (limits: WatchGroupLimits) =>
  Layer.effect(
    WatchGroupService,
    Effect.gen(function* () {
      const auth = yield* AuthService;
      const media = yield* PlaybackMedia;
      const playback = yield* PlaybackService;
      const access = yield* AccessControl;
      const logger = yield* ServerLogger;
      const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
        Effect.runPromise(
          effect.pipe(
            Effect.timeoutOrElse({
              duration: limits.validationTimeoutMs,
              orElse: () =>
                Effect.fail(new GroupFailure("unavailable", "Watch group validation timed out")),
            }),
          ),
        );
      const registry = new GroupRegistry({
        limits,
        now: () => performance.now(),
        validate: (principal) => run(auth.validateSession(principal.sessionId, Date.now())),
        resolve: (principal, id, exact) =>
          run(
            media
              .resolve(principal, id, Date.now(), exact)
              .pipe(Effect.map(({ title: _title, ...source }) => source)),
          ),
        canPlay: (principal, source) =>
          run(
            access.requireTrack(principal, source.trackId, "playback:control", Date.now()).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            ),
          ),
        startSession: (principal, source) =>
          run(playback.start(principal, { trackId: source.itemId }, Date.now(), source)),
        closeSession: (principal, id) => run(playback.stop(principal, id, Date.now())),
        log: (event, fields) => logger.debug(event, fields),
      });
      const timer = setInterval(() => void registry.sweep(), Math.min(1_000, limits.refreshMs));
      timer.unref();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          clearInterval(timer);
          await registry.dispose();
        }),
      );
      return registry;
    }),
  );
