import type { LoginResponse, User } from "@lumen/contracts";
import {
  authSessions,
  Database,
  devices,
  refreshTokens,
  Repositories,
  users,
} from "@lumen/database";
import { and, count, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { mapRepositoryError } from "../core/Cause";
import { conflict, forbidden, unauthorized } from "../core/Errors";
import { hashPassword, hashToken, newUuid, verifyPassword } from "../core/Security";
import type { Schema } from "effect";
import type { LoginBody, RegisterBody } from "../http/Schemas";
import {
  createSessionToken,
  sessionExpiresInMs,
  sessionIdFromToken,
  sessionVerificationIntervalMs,
  verifySessionToken,
} from "./AuthSessionToken";
type LoginInput = Schema.Schema.Type<typeof LoginBody>;
type RegisterInput = Schema.Schema.Type<typeof RegisterBody>;

export interface AuthPrincipal {
  readonly user: User;
  readonly sessionId: string;
  readonly deviceId: string;
}

const normalizeUsername = (username: string): string => username.trim().toLowerCase();
const sessionResponse = (
  userId: string,
  role: User["role"],
  id: string,
  token: string,
  nowMs: number,
): LoginResponse => ({
  userId,
  role,
  sessionId: id,
  accessToken: token,
  accessExpiresAtMs: nowMs + sessionExpiresInMs,
});

export interface AuthServiceShape {
  readonly setupRequired: () => Effect.Effect<boolean, unknown>;
  readonly register: (input: RegisterInput, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
  readonly login: (input: LoginInput, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
  readonly migrateLegacySession: (
    refreshToken: string,
    nowMs: number,
  ) => Effect.Effect<LoginResponse, unknown>;
  readonly authenticate: (token: string, nowMs: number) => Effect.Effect<AuthPrincipal, unknown>;
  readonly logout: (
    principal: AuthPrincipal,
    sessionId: string,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
}

export const makeAuthService = Effect.gen(function* () {
  const repositories = yield* Repositories;
  const database = yield* Database;

  const setupRequired: AuthServiceShape["setupRequired"] = Effect.fn("AuthService.setupRequired")(
    function* () {
      const row = yield* database.select({ count: count() }).from(users).get();
      return (row?.count ?? 0) === 0;
    },
  );

  const register: AuthServiceShape["register"] = Effect.fn("AuthService.register")(
    function* (input, nowMs) {
      const username = input.username.trim();
      const normalized = normalizeUsername(username);
      if (!/^[a-z0-9._-]+$/u.test(normalized))
        return yield* conflict("Username contains unsupported characters");
      const passwordHash = yield* Effect.promise(() => hashPassword(input.password));
      yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const existing = yield* transaction.select({ count: count() }).from(users).get();
          const duplicate = yield* transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.usernameNormalized, normalized))
            .get();
          if (duplicate != null) return yield* conflict("Username is already taken");
          const role = (existing?.count ?? 0) === 0 ? "admin" : "user";
          yield* transaction.insert(users).values({
            id: newUuid(),
            username,
            usernameNormalized: normalized,
            displayName: input.displayName.trim(),
            passwordHash,
            role,
            isActive: true,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          });
        }),
      );
      return yield* login(
        {
          username: input.username,
          password: input.password,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          platform: input.platform,
          platformDeviceId: input.platformDeviceId,
        },
        nowMs,
      );
    },
  );

  const login: AuthServiceShape["login"] = Effect.fn("AuthService.login")(function* (input, nowMs) {
    const credentialsRow = yield* database
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        isActive: users.isActive,
        createdAtMs: users.createdAtMs,
        updatedAtMs: users.updatedAtMs,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.usernameNormalized, normalizeUsername(input.username)))
      .get()
      .pipe(Effect.catch(() => unauthorized("Invalid username or password")));
    if (credentialsRow == null) return yield* unauthorized("Invalid username or password");
    const credentials = {
      user: { ...credentialsRow, role: credentialsRow.role as User["role"] },
      passwordHash: credentialsRow.passwordHash,
    };
    if (
      !credentials.user.isActive ||
      !(yield* Effect.promise(() => verifyPassword(input.password, credentials.passwordHash)))
    ) {
      return yield* unauthorized("Invalid username or password");
    }
    const existingDevice = yield* database
      .select({
        userId: devices.userId,
        revokedAtMs: devices.revokedAtMs,
      })
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .get();
    if (
      existingDevice != null &&
      (existingDevice.userId !== credentials.user.id || existingDevice.revokedAtMs !== null)
    )
      return yield* unauthorized("Device is unavailable");
    const device =
      existingDevice == null
        ? yield* repositories.auth
            .createDevice({
              id: input.deviceId,
              userId: credentials.user.id,
              name: input.deviceName,
              platform: input.platform,
              platformDeviceId: input.platformDeviceId,
              nowMs,
            })
            .pipe(Effect.mapError(mapRepositoryError))
        : yield* database
            .update(devices)
            .set({
              name: input.deviceName,
              platform: input.platform,
              platformDeviceId: input.platformDeviceId,
              lastSeenAtMs: nowMs,
              revokedAtMs: null,
            })
            .where(and(eq(devices.id, input.deviceId), eq(devices.userId, credentials.user.id)))
            .pipe(Effect.as({ id: input.deviceId }));
    const { id, token, secretHash } = createSessionToken();
    yield* repositories.auth
      .createSession({
        id,
        userId: credentials.user.id,
        deviceId: device.id,
        sessionTokenHash: secretHash,
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + sessionExpiresInMs,
      })
      .pipe(Effect.mapError(mapRepositoryError));
    return sessionResponse(credentials.user.id, credentials.user.role, id, token, nowMs);
  });

  const migrateLegacySession: AuthServiceShape["migrateLegacySession"] = Effect.fn(
    "AuthService.migrateLegacySession",
  )(function* (refreshToken, nowMs) {
    const { id, token, secretHash } = createSessionToken();
    const previous = yield* database.transaction((transaction) =>
      Effect.gen(function* () {
        const row = yield* transaction
          .select({
            sessionId: refreshTokens.sessionId,
            userId: authSessions.userId,
            deviceId: authSessions.deviceId,
            role: users.role,
            tokenExpiresAtMs: refreshTokens.expiresAtMs,
            tokenUsedAtMs: refreshTokens.usedAtMs,
            tokenRevokedAtMs: refreshTokens.revokedAtMs,
            sessionRevokedAtMs: authSessions.revokedAtMs,
            deviceRevokedAtMs: devices.revokedAtMs,
            isActive: users.isActive,
          })
          .from(refreshTokens)
          .innerJoin(authSessions, eq(authSessions.id, refreshTokens.sessionId))
          .innerJoin(
            devices,
            and(eq(devices.id, authSessions.deviceId), eq(devices.userId, authSessions.userId)),
          )
          .innerJoin(users, eq(users.id, authSessions.userId))
          .where(eq(refreshTokens.tokenHash, hashToken(refreshToken)))
          .get();
        if (
          row == null ||
          row.tokenExpiresAtMs <= nowMs ||
          row.tokenUsedAtMs !== null ||
          row.tokenRevokedAtMs !== null ||
          row.sessionRevokedAtMs !== null ||
          row.deviceRevokedAtMs !== null ||
          !row.isActive
        )
          return yield* unauthorized("Sign-in required");
        yield* transaction
          .update(refreshTokens)
          .set({ usedAtMs: nowMs, revokedAtMs: nowMs })
          .where(eq(refreshTokens.tokenHash, hashToken(refreshToken)));
        yield* transaction
          .update(authSessions)
          .set({ revokedAtMs: nowMs })
          .where(eq(authSessions.id, row.sessionId));
        yield* transaction.insert(authSessions).values({
          id,
          userId: row.userId,
          deviceId: row.deviceId,
          sessionTokenHash: secretHash,
          issuedAtMs: nowMs,
          lastUsedAtMs: nowMs,
          expiresAtMs: nowMs + sessionExpiresInMs,
        });
        return { ...row, role: row.role as User["role"] };
      }),
    );
    return sessionResponse(previous.userId, previous.role, id, token, nowMs);
  });

  const authenticate: AuthServiceShape["authenticate"] = Effect.fn("AuthService.authenticate")(
    function* (token, nowMs) {
      const sessionId = sessionIdFromToken(token);
      if (sessionId === null) return yield* unauthorized();
      const session = yield* database
        .select({
          id: authSessions.id,
          userId: authSessions.userId,
          deviceId: authSessions.deviceId,
          secretHash: authSessions.sessionTokenHash,
          lastVerifiedAtMs: authSessions.lastUsedAtMs,
          expiresAtMs: authSessions.expiresAtMs,
          revokedAtMs: authSessions.revokedAtMs,
        })
        .from(authSessions)
        .where(eq(authSessions.id, sessionId))
        .get();
      if (
        session == null ||
        session.revokedAtMs !== null ||
        nowMs - session.lastVerifiedAtMs >= sessionExpiresInMs ||
        session.expiresAtMs <= nowMs ||
        !verifySessionToken(token, session.id, session.secretHash)
      )
        return yield* unauthorized();
      const row = yield* database
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
          isActive: users.isActive,
          createdAtMs: users.createdAtMs,
          updatedAtMs: users.updatedAtMs,
          deviceRevokedAtMs: devices.revokedAtMs,
        })
        .from(users)
        .innerJoin(devices, and(eq(devices.id, session.deviceId), eq(devices.userId, users.id)))
        .where(eq(users.id, session.userId))
        .get();
      if (row == null || !row.isActive || row.deviceRevokedAtMs !== null)
        return yield* unauthorized();
      const { deviceRevokedAtMs: _deviceRevokedAtMs, ...userRow } = row;
      const user = { ...userRow, role: userRow.role as User["role"] };
      if (nowMs - session.lastVerifiedAtMs >= sessionVerificationIntervalMs) {
        yield* database
          .update(authSessions)
          .set({
            lastUsedAtMs: nowMs,
            expiresAtMs: nowMs + sessionExpiresInMs,
          })
          .where(eq(authSessions.id, session.id));
      }
      yield* database
        .update(devices)
        .set({ lastSeenAtMs: nowMs })
        .where(eq(devices.id, session.deviceId));
      return { user, sessionId: session.id, deviceId: session.deviceId };
    },
  );

  const logout: AuthServiceShape["logout"] = Effect.fn("AuthService.logout")(
    function* (principal, sessionId, nowMs) {
      const row = yield* database
        .select({ userId: authSessions.userId })
        .from(authSessions)
        .where(eq(authSessions.id, sessionId))
        .get();
      if (principal.user.role !== "admin" && (row == null || row.userId !== principal.user.id)) {
        return yield* forbidden("Cannot revoke another user's session");
      }
      yield* repositories.auth
        .revokeSession({ sessionId, nowMs })
        .pipe(Effect.mapError(mapRepositoryError));
    },
  );

  return { setupRequired, register, login, migrateLegacySession, authenticate, logout };
});

export class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
  "@lumen/server/Auth",
) {}

export const AuthServiceLive = Layer.effect(AuthService, makeAuthService);
