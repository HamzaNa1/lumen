import {
  AuthSession,
  CreateAuthSession,
  CreateDevice,
  CreateUser,
  Device,
  RefreshToken,
  RevokeSession,
  RotateRefreshToken,
  User,
  UserCredentials,
  Uuid,
} from "@lumen/contracts";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
import { authSessions, devices, refreshTokens, users } from "../tables/schema";
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

const refreshSelection = {
  id: refreshTokens.id,
  sessionId: refreshTokens.sessionId,
  tokenHash: refreshTokens.tokenHash,
  familyId: refreshTokens.familyId,
  generation: refreshTokens.generation,
  issuedAtMs: refreshTokens.issuedAtMs,
  expiresAtMs: refreshTokens.expiresAtMs,
  usedAtMs: refreshTokens.usedAtMs,
  revokedAtMs: refreshTokens.revokedAtMs,
  replacedByTokenId: refreshTokens.replacedByTokenId,
};

const FindActiveSessions = Schema.Struct({ id: Uuid, nowMs: Schema.Int });
const FindUserByUsername = Schema.Struct({ usernameNormalized: Schema.String });
const FindByDigest = Schema.Struct({ digest: Schema.String });

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
    const row = yield* guard(
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const [session] = yield* transaction
            .insert(authSessions)
            .values({
              id: value.id,
              userId: value.userId,
              deviceId: value.deviceId,
              sessionTokenHash: value.sessionTokenHash,
              issuedAtMs: value.issuedAtMs,
              lastUsedAtMs: value.issuedAtMs,
              expiresAtMs: value.expiresAtMs,
            })
            .returning(sessionSelection);
          yield* transaction.insert(refreshTokens).values({
            id: value.refreshTokenId,
            sessionId: value.id,
            tokenHash: value.refreshTokenHash,
            familyId: value.refreshFamilyId,
            generation: value.refreshGeneration ?? 0,
            issuedAtMs: value.issuedAtMs,
            expiresAtMs: value.refreshExpiresAtMs,
          });
          return session;
        }),
      ),
      "auth.createSession",
    );
    return yield* boundary(AuthSession, row, "auth.createSession.result");
  });

  const getSessionByTokenHash = Effect.fn("AuthRepository.getSessionByTokenHash")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(FindByDigest, input, "auth.getSessionByTokenHash");
    const row = yield* guard(
      database
        .select(sessionSelection)
        .from(authSessions)
        .where(eq(authSessions.sessionTokenHash, value.digest))
        .get(),
      "auth.getSessionByTokenHash",
    );
    return yield* boundary(AuthSession, row, "auth.getSessionByTokenHash.result");
  });

  const getRefreshTokenByHash = Effect.fn("AuthRepository.getRefreshTokenByHash")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(FindByDigest, input, "auth.getRefreshTokenByHash");
    const row = yield* guard(
      database
        .select(refreshSelection)
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, value.digest))
        .get(),
      "auth.getRefreshTokenByHash",
    );
    return yield* boundary(RefreshToken, row, "auth.getRefreshTokenByHash.result");
  });

  const rotateRefreshToken = Effect.fn("AuthRepository.rotateRefreshToken")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(RotateRefreshToken, input, "auth.rotateRefreshToken");
    const row = yield* guard(
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const [current] = yield* transaction
            .select(refreshSelection)
            .from(refreshTokens)
            .where(
              and(
                eq(refreshTokens.id, value.currentTokenId),
                eq(refreshTokens.sessionId, value.sessionId),
                isNull(refreshTokens.usedAtMs),
                isNull(refreshTokens.revokedAtMs),
              ),
            )
            .limit(1);
          const currentValue = yield* boundary(
            RefreshToken,
            current,
            "auth.rotateRefreshToken.current",
          );
          const [replacement] = yield* transaction
            .insert(refreshTokens)
            .values({
              id: value.replacementTokenId,
              sessionId: value.sessionId,
              tokenHash: value.replacementTokenHash,
              familyId: currentValue.familyId,
              generation: currentValue.generation + 1,
              issuedAtMs: value.issuedAtMs,
              expiresAtMs: value.expiresAtMs,
            })
            .returning(refreshSelection);
          const [consumed] = yield* transaction
            .update(refreshTokens)
            .set({
              usedAtMs: value.issuedAtMs,
              revokedAtMs: value.issuedAtMs,
              replacedByTokenId: value.replacementTokenId,
            })
            .where(
              and(
                eq(refreshTokens.id, value.currentTokenId),
                eq(refreshTokens.sessionId, value.sessionId),
                isNull(refreshTokens.usedAtMs),
                isNull(refreshTokens.revokedAtMs),
              ),
            )
            .returning(refreshSelection);
          yield* boundary(RefreshToken, consumed, "auth.rotateRefreshToken.consume");
          return replacement;
        }),
      ),
      "auth.rotateRefreshToken",
    );
    return yield* boundary(RefreshToken, row, "auth.rotateRefreshToken.result");
  });

  const revokeSession = Effect.fn("AuthRepository.revokeSession")(function* (input: unknown) {
    const value = yield* boundary(RevokeSession, input, "auth.revokeSession");
    yield* guard(
      database.transaction((transaction) =>
        Effect.gen(function* () {
          yield* transaction
            .update(authSessions)
            .set({ revokedAtMs: value.nowMs })
            .where(and(eq(authSessions.id, value.sessionId), isNull(authSessions.revokedAtMs)));
          yield* transaction
            .update(refreshTokens)
            .set({ revokedAtMs: value.nowMs })
            .where(
              and(eq(refreshTokens.sessionId, value.sessionId), isNull(refreshTokens.revokedAtMs)),
            );
        }),
      ),
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
    getSessionByTokenHash,
    getRefreshTokenByHash,
    rotateRefreshToken,
    revokeSession,
    listActiveSessions,
  };
};

export type AuthRepository = ReturnType<typeof makeAuthRepository>;
