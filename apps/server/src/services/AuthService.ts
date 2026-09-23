import type { LoginResponse, User } from "@lumen/contracts";
import { Database, Repositories, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { mapRepositoryError } from "../core/Cause";
import { conflict, forbidden, unauthorized } from "../core/Errors";
import { hashPassword, hashToken, newOpaqueToken, newUuid, verifyPassword } from "../core/Security";
import type { Schema } from "effect";
import type { LoginBody, RefreshBody, RegisterBody } from "../http/Schemas";
type LoginInput = Schema.Schema.Type<typeof LoginBody>;
type RegisterInput = Schema.Schema.Type<typeof RegisterBody>;
type RefreshInput = Schema.Schema.Type<typeof RefreshBody>;

export interface AuthPrincipal {
  readonly user: User;
  readonly sessionId: string;
  readonly deviceId: string;
}

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

export interface AuthServiceShape {
  readonly setupRequired: () => Effect.Effect<boolean, unknown>;
  readonly register: (input: RegisterInput, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
  readonly login: (input: LoginInput, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
  readonly refresh: (input: RefreshInput, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
  readonly authenticate: (token: string, nowMs: number) => Effect.Effect<AuthPrincipal, unknown>;
  readonly logout: (principal: AuthPrincipal, sessionId: string, nowMs: number) => Effect.Effect<void, unknown>;
}

export const makeAuthService = Effect.gen(function* () {
  const repositories = yield* Repositories;
  const database = yield* Database;

  const setupRequired: AuthServiceShape["setupRequired"] = Effect.fn("AuthService.setupRequired")(function* () {
    const row = yield* database.get<{ count: number }>(sql`SELECT count(*) AS count FROM users`);
    return (row?.count ?? 0) === 0;
  });

  const register: AuthServiceShape["register"] = Effect.fn("AuthService.register")(function* (input, nowMs) {
    const username = input.username.trim();
    const normalized = normalizeUsername(username);
    if (!/^[a-z0-9._-]+$/u.test(normalized)) return yield* conflict("Username contains unsupported characters");
    if (!(yield* setupRequired())) return yield* conflict("An administrator already exists");
    const passwordHash = yield* Effect.promise(() => hashPassword(input.password));
    yield* database.transaction((transaction) => Effect.gen(function* () {
      const existing = yield* transaction.get<{ count: number }>(sql`SELECT count(*) AS count FROM users`);
      if ((existing?.count ?? 0) > 0) return yield* conflict("An administrator already exists");
      yield* transaction.run(sql`
        INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
        VALUES (${newUuid()}, ${username}, ${normalized}, ${input.displayName.trim()}, ${passwordHash}, 'admin', 1, ${nowMs}, ${nowMs})
      `);
    }));
    return yield* login({
      username: input.username,
      password: input.password,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: input.platform,
      platformDeviceId: input.platformDeviceId,
    }, nowMs);
  });

  const login: AuthServiceShape["login"] = Effect.fn("AuthService.login")(function* (input, nowMs) {
    const credentialsRow = yield* database.get<{
      id: string;
      username: string;
      displayName: string;
      role: User["role"];
      isActive: number;
      createdAtMs: number;
      updatedAtMs: number;
      passwordHash: string;
    }>(sql`
      SELECT id, username, display_name AS displayName, role, is_active AS isActive,
        created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs, password_hash AS passwordHash
      FROM users WHERE username_normalized = ${normalizeUsername(input.username)}
    `).pipe(Effect.catch(() => unauthorized("Invalid username or password")));
    if (credentialsRow == null) return yield* unauthorized("Invalid username or password");
    const credentials = { user: { ...credentialsRow, isActive: credentialsRow.isActive === 1 }, passwordHash: credentialsRow.passwordHash };
    if (!credentials.user.isActive || !(yield* Effect.promise(() => verifyPassword(input.password, credentials.passwordHash)))) {
      return yield* unauthorized("Invalid username or password");
    }
    const existingDevice = yield* database.get<{ userId: string; revokedAtMs: number | null }>(sql`
      SELECT user_id AS userId, revoked_at_ms AS revokedAtMs FROM devices WHERE id = ${input.deviceId}
    `);
    if (existingDevice != null && (existingDevice.userId !== credentials.user.id || existingDevice.revokedAtMs !== null)) return yield* unauthorized("Device is unavailable");
    const device = existingDevice == null
      ? yield* repositories.auth.createDevice({
        id: input.deviceId, userId: credentials.user.id, name: input.deviceName, platform: input.platform, platformDeviceId: input.platformDeviceId, nowMs,
      }).pipe(Effect.mapError(mapRepositoryError))
      : yield* database.run(sql`
        UPDATE devices SET name = ${input.deviceName}, platform = ${input.platform}, platform_device_id = ${input.platformDeviceId}, last_seen_at_ms = ${nowMs}, revoked_at_ms = NULL
        WHERE id = ${input.deviceId} AND user_id = ${credentials.user.id}
      `).pipe(Effect.as({ id: input.deviceId, userId: credentials.user.id, name: input.deviceName, platform: input.platform, platformDeviceId: input.platformDeviceId, lastSeenAtMs: nowMs, createdAtMs: nowMs, revokedAtMs: null }));
    const accessToken = newOpaqueToken();
    const refreshToken = newOpaqueToken();
    yield* repositories.auth.createSession({
      id: newUuid(),
      userId: credentials.user.id,
      deviceId: device.id,
      sessionTokenHash: hashToken(accessToken),
      refreshTokenId: newUuid(),
      refreshTokenHash: hashToken(refreshToken),
      refreshFamilyId: newUuid(),
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 900_000,
      refreshExpiresAtMs: nowMs + 2_592_000_000,
    }).pipe(Effect.mapError(mapRepositoryError));
    const session = yield* repositories.auth
      .getSessionByTokenHash({ digest: hashToken(accessToken) })
      .pipe(Effect.mapError(mapRepositoryError));
    return {
      userId: credentials.user.id,
      role: credentials.user.role,
      sessionId: session.id,
      accessToken,
      refreshToken,
      accessExpiresAtMs: session.expiresAtMs,
      refreshExpiresAtMs: nowMs + 2_592_000_000,
    };
  });

  const refresh: AuthServiceShape["refresh"] = Effect.fn("AuthService.refresh")(function* (input, nowMs) {
    const digest = hashToken(input.refreshToken);
    const current = yield* repositories.auth.getRefreshTokenByHash({ digest }).pipe(Effect.mapError(mapRepositoryError));
    if (current.usedAtMs !== null || current.revokedAtMs !== null || current.expiresAtMs <= nowMs) {
      yield* repositories.auth.revokeSession({ sessionId: current.sessionId, nowMs }).pipe(Effect.mapError(mapRepositoryError));
      return yield* unauthorized("Refresh token is invalid");
    }
    const session = yield* database.get<{
      id: string;
      userId: string;
      deviceId: string;
      role: User["role"];
      isActive: number;
      expiresAtMs: number;
      revokedAtMs: number | null;
    }>(sql`
      SELECT s.id, s.user_id AS userId, s.device_id AS deviceId, u.role, u.is_active AS isActive,
        s.expires_at_ms AS expiresAtMs, s.revoked_at_ms AS revokedAtMs
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${current.sessionId}
    `);
    if (session == null || session.isActive !== 1 || session.revokedAtMs !== null || session.expiresAtMs <= nowMs) {
      return yield* unauthorized("Session is invalid");
    }
    const accessToken = newOpaqueToken();
    const replacement = newOpaqueToken();
    yield* repositories.auth.rotateRefreshToken({
      currentTokenId: current.id,
      sessionId: current.sessionId,
      replacementTokenId: newUuid(),
      replacementTokenHash: hashToken(replacement),
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 2_592_000_000,
    }).pipe(Effect.mapError(mapRepositoryError));
    yield* database.run(sql`
      UPDATE auth_sessions
      SET last_used_at_ms = ${nowMs}, expires_at_ms = ${nowMs + 900_000}
      WHERE id = ${current.sessionId} AND revoked_at_ms IS NULL
    `);
    return {
      userId: session.userId,
      role: session.role,
      sessionId: session.id,
      accessToken,
      refreshToken: replacement,
      accessExpiresAtMs: nowMs + 900_000,
      refreshExpiresAtMs: nowMs + 2_592_000_000,
    };
  });

  const authenticate: AuthServiceShape["authenticate"] = Effect.fn("AuthService.authenticate")(function* (token, nowMs) {
    if (token.length < 32 || token.length > 1024) return yield* unauthorized();
    const session = yield* repositories.auth.getSessionByTokenHash({ digest: hashToken(token) }).pipe(Effect.mapError(mapRepositoryError));
    if (session.revokedAtMs !== null || session.expiresAtMs <= nowMs) return yield* unauthorized();
    const row = yield* database.get<{
      id: string;
      username: string;
      displayName: string;
      role: User["role"];
      isActive: number;
      createdAtMs: number;
      updatedAtMs: number;
      deviceRevokedAtMs: number | null;
    }>(sql`
      SELECT u.id, u.username, u.display_name AS displayName, u.role, u.is_active AS isActive,
        u.created_at_ms AS createdAtMs, u.updated_at_ms AS updatedAtMs,
        d.revoked_at_ms AS deviceRevokedAtMs
      FROM users u
      JOIN devices d ON d.id = ${session.deviceId} AND d.user_id = u.id
      WHERE u.id = ${session.userId}
    `);
    if (row == null || row.isActive !== 1 || row.deviceRevokedAtMs !== null) return yield* unauthorized();
    const { deviceRevokedAtMs: _deviceRevokedAtMs, isActive: _isActive, ...userRow } = row;
    const user = { ...userRow, isActive: true };
    yield* database.run(sql`UPDATE auth_sessions SET last_used_at_ms = ${nowMs} WHERE id = ${session.id}`);
    yield* database.run(sql`UPDATE devices SET last_seen_at_ms = ${nowMs} WHERE id = ${session.deviceId}`);
    return { user, sessionId: session.id, deviceId: session.deviceId };
  });

  const logout: AuthServiceShape["logout"] = Effect.fn("AuthService.logout")(function* (principal, sessionId, nowMs) {
    const row = yield* database.get<{ userId: string }>(sql`
      SELECT user_id AS userId FROM auth_sessions WHERE id = ${sessionId}
    `);
    if (principal.user.role !== "admin" && (row == null || row.userId !== principal.user.id)) {
      return yield* forbidden("Cannot revoke another user's session");
    }
    yield* repositories.auth.revokeSession({ sessionId, nowMs }).pipe(Effect.mapError(mapRepositoryError));
  });

  return { setupRequired, register, login, refresh, authenticate, logout };
});

export class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
  "@lumen/server/Auth",
) {}

export const AuthServiceLive = Layer.effect(AuthService, makeAuthService);
