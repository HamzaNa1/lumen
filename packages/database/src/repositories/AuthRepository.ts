import {
  AuthSession,
  CreateAuthSession,
  CreateDevice,
  CreateUser,
  Device,
  RevokeSession,
  User,
  UserCredentials,
  Uuid,
} from "@lumen/contracts";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
import { authSessions, devices, users } from "../tables/schema";
import { boundary, guard } from "./Boundary";

const userSelection = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  isActive: users.isActive,
  createdAtMs: users.createdAtMs,
  updatedAtMs: users.updatedAtMs,
};

const deviceSelection = {
  id: devices.id,
  userId: devices.userId,
  name: devices.name,
  platform: devices.platform,
  platformDeviceId: devices.platformDeviceId,
  lastSeenAtMs: devices.lastSeenAtMs,
  createdAtMs: devices.createdAtMs,
  revokedAtMs: devices.revokedAtMs,
};

const sessionSelection = {
  id: authSessions.id,
  userId: authSessions.userId,
  deviceId: authSessions.deviceId,
  sessionTokenHash: authSessions.sessionTokenHash,
  issuedAtMs: authSessions.issuedAtMs,
  lastUsedAtMs: authSessions.lastUsedAtMs,
  expiresAtMs: authSessions.expiresAtMs,
  revokedAtMs: authSessions.revokedAtMs,
};

const FindActiveSessions = Schema.Struct({ id: Uuid, nowMs: Schema.Int });
const FindUserByUsername = Schema.Struct({ usernameNormalized: Schema.String });

export const makeAuthRepository = (database: DatabaseClient) => {
  const createUser = Effect.fn("AuthRepository.createUser")(function* (input: unknown) {
    const value = yield* boundary(CreateUser, input, "auth.createUser");
    const resultRows = yield* guard(
      database
        .insert(users)
        .values({
          id: value.id,
          username: value.username,
          usernameNormalized: value.usernameNormalized,
          displayName: value.displayName,
          passwordHash: value.passwordHash,
          role: value.role ?? "user",
          createdAtMs: value.nowMs,
          updatedAtMs: value.nowMs,
        })
        .returning(userSelection),
      "auth.createUser",
    );
    const [row] = resultRows;
    return yield* boundary(User, row, "auth.createUser.result");
  });

  const getUser = Effect.fn("AuthRepository.getUser")(function* (input: unknown) {
    const value = yield* boundary(Schema.Struct({ id: Uuid }), input, "auth.getUser");
    const row = yield* guard(
      database.select(userSelection).from(users).where(eq(users.id, value.id)).get(),
      "auth.getUser",
    );
    return yield* boundary(User, row, "auth.getUser.result");
  });

  const getCredentialsByUsername = Effect.fn("AuthRepository.getCredentialsByUsername")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(FindUserByUsername, input, "auth.getCredentialsByUsername");
    const row = yield* guard(
      database
        .select({ ...userSelection, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.usernameNormalized, value.usernameNormalized))
        .get(),
      "auth.getCredentialsByUsername",
    );
    return yield* boundary(UserCredentials, row, "auth.getCredentialsByUsername.result");
  });

  const createDevice = Effect.fn("AuthRepository.createDevice")(function* (input: unknown) {
    const value = yield* boundary(CreateDevice, input, "auth.createDevice");
    const resultRows = yield* guard(
      database
        .insert(devices)
        .values({
          id: value.id,
          userId: value.userId,
          name: value.name,
          platform: value.platform,
          platformDeviceId: value.platformDeviceId ?? null,
          lastSeenAtMs: value.nowMs,
          createdAtMs: value.nowMs,
        })
        .returning(deviceSelection),
      "auth.createDevice",
    );
    const [row] = resultRows;
    return yield* boundary(Device, row, "auth.createDevice.result");
  });

  const createSession = Effect.fn("AuthRepository.createSession")(function* (input: unknown) {
    const value = yield* boundary(CreateAuthSession, input, "auth.createSession");
    const rows = yield* guard(
      database.insert(authSessions).values({
        id: value.id,
        userId: value.userId,
        deviceId: value.deviceId,
        sessionTokenHash: value.sessionTokenHash,
        issuedAtMs: value.issuedAtMs,
        lastUsedAtMs: value.issuedAtMs,
        expiresAtMs: value.expiresAtMs,
      }).returning(sessionSelection),
      "auth.createSession",
    );
    return yield* boundary(AuthSession, rows[0], "auth.createSession.result");
  });

  const revokeSession = Effect.fn("AuthRepository.revokeSession")(function* (input: unknown) {
    const value = yield* boundary(RevokeSession, input, "auth.revokeSession");
    yield* guard(
      database.update(authSessions).set({ revokedAtMs: value.nowMs })
        .where(and(eq(authSessions.id, value.sessionId), isNull(authSessions.revokedAtMs))),
      "auth.revokeSession",
    );
  });

  const listActiveSessions = Effect.fn("AuthRepository.listActiveSessions")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(FindActiveSessions, input, "auth.listActiveSessions");
    const rows = yield* guard(
      database
        .select(sessionSelection)
        .from(authSessions)
        .where(
          and(
            eq(authSessions.userId, value.id),
            isNull(authSessions.revokedAtMs),
            gt(authSessions.expiresAtMs, value.nowMs),
          ),
        ),
      "auth.listActiveSessions",
    );
    return yield* boundary(Schema.Array(AuthSession), rows, "auth.listActiveSessions.result");
  });

  return {
    createUser,
    getUser,
    getCredentialsByUsername,
    createDevice,
    createSession,
    revokeSession,
    listActiveSessions,
  };
};

export type AuthRepository = ReturnType<typeof makeAuthRepository>;
