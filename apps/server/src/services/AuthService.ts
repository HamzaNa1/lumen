import type { LoginResponse, User } from "@lumen/contracts";
import { Database, Repositories, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { mapRepositoryError } from "../core/Cause";
import { conflict, forbidden, unauthorized } from "../core/Errors";
import { hashPassword, hashToken, newUuid, verifyPassword } from "../core/Security";
import type { Schema } from "effect";
import type { LoginBody, RegisterBody } from "../http/Schemas";
import { createSessionToken, sessionExpiresInMs, sessionIdFromToken, sessionVerificationIntervalMs, verifySessionToken } from "./AuthSessionToken";
type LoginInput = Schema.Schema.Type<typeof LoginBody>;
type RegisterInput = Schema.Schema.Type<typeof RegisterBody>;

export interface AuthPrincipal {
  readonly user: User;
  readonly sessionId: string;
  readonly deviceId: string;
}

const normalizeUsername = (username: string): string => username.trim().toLowerCase();
const sessionResponse = (userId: string, role: User["role"], id: string, token: string, nowMs: number): LoginResponse => ({
  userId, role, sessionId: id, accessToken: token, accessExpiresAtMs: nowMs + sessionExpiresInMs,
});

export interface AuthServiceShape {
  readonly setupRequired: () => Effect.Effect<boolean, unknown>;
  readonly register: (input: RegisterInput, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
  readonly login: (input: LoginInput, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
  readonly migrateLegacySession: (refreshToken: string, nowMs: number) => Effect.Effect<LoginResponse, unknown>;
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
    const passwordHash = yield* Effect.promise(() => hashPassword(input.password));
    yield* database.transaction((transaction) => Effect.gen(function* () {
      const existing = yield* transaction.get<{ count: number }>(sql`SELECT count(*) AS count FROM users`);
      const duplicate = yield* transaction.get<{ id: string }>(sql`SELECT id FROM users WHERE username_normalized = ${normalized}`);
      if (duplicate != null) return yield* conflict("Username is already taken");
      const role = (existing?.count ?? 0) === 0 ? "admin" : "user";
      yield* transaction.run(sql`
        INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
        VALUES (${newUuid()}, ${username}, ${normalized}, ${input.displayName.trim()}, ${passwordHash}, ${role}, 1, ${nowMs}, ${nowMs})
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
    const { id, token, secretHash } = createSessionToken();
    yield* repositories.auth.createSession({
      id, userId: credentials.user.id, deviceId: device.id,
      sessionTokenHash: secretHash, issuedAtMs: nowMs, expiresAtMs: nowMs + sessionExpiresInMs,
    }).pipe(Effect.mapError(mapRepositoryError));
    return sessionResponse(credentials.user.id, credentials.user.role, id, token, nowMs);
  });

  const migrateLegacySession: AuthServiceShape["migrateLegacySession"] = Effect.fn("AuthService.migrateLegacySession")(function* (refreshToken, nowMs) {
    const { id, token, secretHash } = createSessionToken();
    const previous = yield* database.transaction((transaction) => Effect.gen(function* () {
      const row = yield* transaction.get<{
        sessionId: string; userId: string; deviceId: string; role: User["role"];
        tokenExpiresAtMs: number; tokenUsedAtMs: number | null; tokenRevokedAtMs: number | null;
        sessionRevokedAtMs: number | null; deviceRevokedAtMs: number | null; isActive: number;
      }>(sql`
        SELECT r.session_id AS sessionId, s.user_id AS userId, s.device_id AS deviceId, u.role,
          r.expires_at_ms AS tokenExpiresAtMs, r.used_at_ms AS tokenUsedAtMs,
          r.revoked_at_ms AS tokenRevokedAtMs, s.revoked_at_ms AS sessionRevokedAtMs,
          d.revoked_at_ms AS deviceRevokedAtMs, u.is_active AS isActive
        FROM refresh_tokens r
        JOIN auth_sessions s ON s.id = r.session_id
        JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
        JOIN users u ON u.id = s.user_id
        WHERE r.token_hash = ${hashToken(refreshToken)}
      `);
      if (row == null || row.tokenExpiresAtMs <= nowMs || row.tokenUsedAtMs !== null ||
        row.tokenRevokedAtMs !== null || row.sessionRevokedAtMs !== null ||
        row.deviceRevokedAtMs !== null || row.isActive !== 1) return yield* unauthorized("Sign-in required");
      yield* transaction.run(sql`UPDATE refresh_tokens SET used_at_ms = ${nowMs}, revoked_at_ms = ${nowMs} WHERE token_hash = ${hashToken(refreshToken)}`);
      yield* transaction.run(sql`UPDATE auth_sessions SET revoked_at_ms = ${nowMs} WHERE id = ${row.sessionId}`);
      yield* transaction.run(sql`
        INSERT INTO auth_sessions(id, user_id, device_id, session_token_hash, issued_at_ms, last_used_at_ms, expires_at_ms)
        VALUES (${id}, ${row.userId}, ${row.deviceId}, ${secretHash}, ${nowMs}, ${nowMs}, ${nowMs + sessionExpiresInMs})
      `);
      return row;
    }));
    return sessionResponse(previous.userId, previous.role, id, token, nowMs);
  });

  const authenticate: AuthServiceShape["authenticate"] = Effect.fn("AuthService.authenticate")(function* (token, nowMs) {
    const sessionId = sessionIdFromToken(token);
    if (sessionId === null) return yield* unauthorized();
    const session = yield* database.get<{
      id: string; userId: string; deviceId: string; secretHash: string;
      lastVerifiedAtMs: number; expiresAtMs: number; revokedAtMs: number | null;
    }>(sql`
      SELECT id, user_id AS userId, device_id AS deviceId, session_token_hash AS secretHash,
        last_used_at_ms AS lastVerifiedAtMs, expires_at_ms AS expiresAtMs, revoked_at_ms AS revokedAtMs
      FROM auth_sessions WHERE id = ${sessionId}
    `);
    if (session === null || session.revokedAtMs !== null || nowMs - session.lastVerifiedAtMs >= sessionExpiresInMs ||
      session.expiresAtMs <= nowMs || !verifySessionToken(token, session.id, session.secretHash)) return yield* unauthorized();
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
    if (nowMs - session.lastVerifiedAtMs >= sessionVerificationIntervalMs) {
      yield* database.run(sql`UPDATE auth_sessions SET last_used_at_ms = ${nowMs}, expires_at_ms = ${nowMs + sessionExpiresInMs} WHERE id = ${session.id}`);
    }
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

  return { setupRequired, register, login, migrateLegacySession, authenticate, logout };
});

export class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
  "@lumen/server/Auth",
) {}

export const AuthServiceLive = Layer.effect(AuthService, makeAuthService);
