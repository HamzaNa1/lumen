import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { makeLayers } from "../../apps/server/src/Runtime";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { AuthService } from "../../apps/server/src/services/AuthService";
import { PlaybackService } from "../../apps/server/src/services/PlaybackService";
import { seedPlayback } from "../helpers/playback";

test("authorized heartbeats renew playback beyond an hour without reviving expired or revoked sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumen-renewal-"));
  const databasePath = join(root, "db.sqlite");
  try {
    const seeded = await seedPlayback(root, databasePath);
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthService;
        const playback = yield* PlaybackService;
        const now = Date.now();
        const deviceId = crypto.randomUUID();
        const login = yield* auth.login(
          {
            username: "admin",
            password: "correct horse battery staple",
            deviceId,
            deviceName: "Long movie",
            platform: "desktop",
            platformDeviceId: deviceId,
          },
          now,
        );
        const principal = yield* auth.authenticate(login.accessToken, now);
        const session = yield* playback.start(principal, { trackId: seeded.itemId }, now);
        const renewed = yield* playback.heartbeat(
          principal,
          session.session.id,
          { state: "playing", activeTrackId: seeded.itemId, errorCode: null },
          now + 3_599_000,
        );
        expect(renewed.expiresAtMs).toBe(now + 7_199_000);
        const grant = yield* playback.authorizeGrant(
          session.grantToken,
          seeded.trackId,
          now + 3_700_000,
        );
        expect(grant.size).toBe(10);
        const expired = yield* Effect.result(
          playback.heartbeat(
            principal,
            session.session.id,
            { state: "playing", activeTrackId: seeded.itemId, errorCode: null },
            now + 7_200_000,
          ),
        );
        expect(expired._tag).toBe("Failure");
        yield* auth.logout(principal, principal.sessionId, now + 3_800_000);
        const revoked = yield* Effect.result(
          playback.heartbeat(
            principal,
            session.session.id,
            { state: "playing", activeTrackId: seeded.itemId, errorCode: null },
            now + 3_900_000,
          ),
        );
        expect(revoked._tag).toBe("Failure");
      }).pipe(Effect.provide(makeLayers({ ...decodeConfig({}), databasePath, dataDir: root }))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
