import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "../../../../packages/database/node_modules/effect/dist/index.js";
import {
  Database,
  DatabaseWithMigrationsLive,
  makeDatabaseRepositories,
} from "../../../../packages/database/src/index";
import { fixtures } from "./fixtures";
import { digests, ids, times } from "./ids";

const [filename, operation] = process.argv.slice(2);
if (!filename) throw new Error("Database path is required");
const nowMs = times.epochMs;
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database;
      const repo = yield* makeDatabaseRepositories(database);
      if (operation === "create") {
        yield* repo.auth.createUser(fixtures.createUser);
        yield* repo.auth.createDevice(fixtures.createDevice);
        yield* repo.auth.createSession({
          id: ids.authSession,
          userId: ids.user,
          deviceId: ids.device,
          sessionTokenHash: digests.session,
          issuedAtMs: nowMs,
          expiresAtMs: nowMs + times.hourMs,
        });
        yield* repo.libraries.create(fixtures.createLibrary);
        yield* repo.libraries.addRoot({
          id: ids.libraryRoot,
          libraryId: ids.library,
          path: "/archive",
          priority: 0,
          nowMs,
        });
        yield* repo.libraries.upsertGrant({
          id: ids.libraryGrant,
          libraryId: ids.library,
          userId: ids.user,
          capabilities: ["library:read", "playback:control"],
          canDownload: true,
          expiresAtMs: null,
          nowMs,
        });
        yield* repo.catalog.createSource(fixtures.createSource);
        yield* repo.catalog.createStream(fixtures.createStream);
        yield* repo.catalog.createChapter({
          id: ids.chapter,
          streamId: ids.stream,
          ordinal: 0,
          title: "Opening",
          startMs: 0,
          endMs: 30000,
        });
        yield* repo.catalog.createSidecar({
          id: ids.sidecar,
          streamId: ids.stream,
          kind: "lyrics",
          relativePath: "Track.lrc",
          mediaType: "text/plain",
          contentHash: digests.sidecar,
        });
        yield* repo.catalog.upsertArtist(fixtures.createArtist);
        yield* repo.catalog.upsertAlbum(fixtures.createAlbum);
        yield* repo.catalog.createTrack(fixtures.createTrack);
        yield* repo.catalog.attachArtist({
          trackId: ids.track,
          artistId: ids.artist,
          ordinal: 0,
          role: "primary",
        });
        yield* repo.catalog.upsertMetadata({
          trackId: ids.track,
          namespace: "core",
          key: "replaygain",
          value: { trackGain: -7.2 },
          language: null,
          sourceId: ids.source,
          nowMs,
        });
        yield* repo.catalog.upsertArtwork({
          id: ids.artwork,
          libraryId: ids.library,
          sourceId: ids.source,
          kind: "front",
          mimeType: "image/jpeg",
          width: 600,
          height: 600,
          byteSize: 12345,
          contentHash: digests.artwork,
          relativePath: "cover.jpg",
          nowMs,
        });
        yield* repo.catalog.assignArtwork({
          artworkId: ids.artwork,
          albumId: ids.album,
          artistId: null,
          trackId: null,
          ordinal: 0,
          isPrimary: true,
        });
        yield* repo.activity.upsertWatchState({
          id: ids.watchState,
          userId: ids.user,
          trackId: ids.track,
          positionMs: 12000,
          completed: false,
          nowMs,
        });
        for (const isFavorite of [true, true, false, true])
          yield* repo.activity.setFavorite({
            userId: ids.user,
            trackId: ids.track,
            isFavorite,
            nowMs,
          });
        yield* repo.activity.startPlayback({
          sessionId: ids.playbackSession,
          userId: ids.user,
          deviceId: ids.device,
          grantTokenHash: digests.playbackGrant,
          activeTrackId: ids.track,
          nowMs,
          expiresAtMs: nowMs + times.hourMs,
        });
        yield* repo.activity.upsertGrant({
          id: ids.playbackGrant,
          sessionId: ids.playbackSession,
          trackId: ids.track,
          canSeek: true,
          canSkip: false,
          maxBitrateKbps: 1920,
          expiresAtMs: nowMs + times.hourMs,
        });
        for (const positionMs of [15000, 17000])
          yield* repo.activity.updateProgress({
            sessionId: ids.playbackSession,
            trackId: ids.track,
            positionMs,
            durationMs: 245000,
            nowMs,
          });
        yield* repo.scanning.startRun({
          runId: ids.scanRun,
          libraryId: ids.library,
          mode: "incremental",
          startedAtMs: nowMs,
        });
        yield* repo.scanning.createJob({
          id: ids.scanJob,
          runId: ids.scanRun,
          parentJobId: null,
          sourceId: ids.source,
          dedupeKey: `probe:${ids.source}`,
          operation: "probe",
          priority: 500,
          maxAttempts: 3,
          availableAtMs: nowMs,
        });
        yield* repo.scanning.enqueueOutbox({
          id: ids.outboxEvent,
          aggregateType: "track",
          aggregateId: ids.track,
          eventType: "track.changed",
          payloadJson: JSON.stringify({ trackId: ids.track }),
          availableAtMs: nowMs,
        });
        return { created: true };
      }
      if (operation === "claim")
        return {
          job: yield* repo.scanning.claimNextJob({
            workerId: process.pid.toString(),
            nowMs,
            operations: ["probe"],
          }),
          event: yield* repo.scanning.claimNextOutbox({ workerId: process.pid.toString(), nowMs }),
        };
      if (operation === "revoke") {
        yield* repo.auth.revokeSession({ sessionId: ids.authSession, nowMs });
        return yield* repo.auth.listActiveSessions({ id: ids.user, nowMs });
      }
      return {
        user: yield* repo.auth.getUser({ id: ids.user }),
        credentials: yield* repo.auth.getCredentialsByUsername({ usernameNormalized: "ada" }),
        sessions: yield* repo.auth.listActiveSessions({ id: ids.user, nowMs }),
        libraries: yield* repo.libraries.list(),
        library: yield* repo.libraries.get({ id: ids.library }),
        roots: yield* repo.libraries.listRoots({ libraryId: ids.library }),
        grants: yield* repo.libraries.listGrants({ libraryId: ids.library }),
        track: yield* repo.catalog.getTrack({ trackId: ids.track }),
        chapters: yield* repo.catalog.listChapters({ streamId: ids.stream }),
        metadata: yield* repo.catalog.listMetadata({ trackId: ids.track }),
        state: yield* repo.activity.getWatchState({ userId: ids.user, trackId: ids.track }),
        favorite: yield* repo.activity.isFavorite({ userId: ids.user, trackId: ids.track }),
        playback: yield* repo.activity.getPlaybackSession({ id: ids.playbackSession }),
        progress: yield* repo.activity.getProgress({ sessionId: ids.playbackSession }),
        run: yield* repo.scanning.getRun({ id: ids.scanRun }),
        job: yield* repo.scanning.getJob({ id: ids.scanJob }),
        jobs: yield* repo.scanning.listJobs({ runId: ids.scanRun }),
        search: yield* repo.search.search({
          query: "Deterministic",
          libraryId: ids.library,
          limit: 10,
          offset: 0,
        }),
      };
    }).pipe(Effect.provide(DatabaseWithMigrationsLive({ filename }))),
  ),
);
console.log(JSON.stringify(result));
if (process.env.LUMEN_COVERAGE_DIR)
  writeFileSync(
    join(process.env.LUMEN_COVERAGE_DIR, `${crypto.randomUUID()}.json`),
    JSON.stringify(
      (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__ ?? {},
    ),
  );
