import { openDatabase } from "./support/database";
import { expect, password, test } from "./support/server";

test("stored session secrets are hashed, refreshed on use, and invalid after inactivity or revocation", async ({
  server,
  admin,
}) => {
  const db = openDatabase(server.databasePath);
  try {
    const secret = db
      .prepare("SELECT session_token_hash AS hash FROM auth_sessions WHERE id = ?")
      .get(admin.sessionId);
    expect(secret?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(admin.accessToken).not.toContain(String(secret?.hash));
    const user = db.prepare("SELECT password_hash AS hash FROM users LIMIT 1").get();
    expect(user?.hash).not.toBe(password);
    const before = Date.now() - 2 * 3600_000;
    db.prepare("UPDATE auth_sessions SET issued_at_ms = ?, last_used_at_ms = ? WHERE id = ?").run(
      before - 1,
      before,
      admin.sessionId,
    );
    await server.api("/auth/me", { token: admin.accessToken });
    expect(
      db
        .prepare("SELECT last_used_at_ms AS lastUsed FROM auth_sessions WHERE id = ?")
        .get(admin.sessionId)?.lastUsed,
    ).toBeGreaterThan(before);
    db.prepare("UPDATE auth_sessions SET issued_at_ms = 1, last_used_at_ms = 1 WHERE id = ?").run(
      admin.sessionId,
    );
    await server.api("/auth/me", { token: admin.accessToken, status: 401 });
    const replacement = await server.login();
    await server.api("/auth/logout", {
      token: replacement.accessToken,
      body: { sessionId: replacement.sessionId },
      status: 200,
    });
    await server.api("/auth/me", { token: replacement.accessToken, status: 401 });
  } finally {
    db.close();
  }
});

for (const ending of ["expired", "stopped", "revoked-access"] as const)
  test(`playback ${ending} refuses heartbeats, progress and media grants`, async ({
    server,
    admin,
  }) => {
    const token = admin.accessToken;
    const library = await server.library(token, "movies", ["Film.mp4"]);
    const itemId = (await server.items(token, library.id))[0]?.id ?? "";
    const user = await server.api<{ id: string }>("/users", {
      token,
      body: {
        username: "viewer",
        displayName: "Viewer",
        password,
        libraryAccess: { scope: "all" },
      },
    });
    const viewer = await server.login("viewer");
    const playback = await server.play(viewer.accessToken, itemId);
    const path = `/playback/sessions/${playback.sessionId}`;
    if (ending === "expired") {
      const db = openDatabase(server.databasePath);
      try {
        db.prepare(
          "UPDATE playback_sessions SET started_at_ms = 1, last_seen_at_ms = 1, expires_at_ms = 2 WHERE id = ?",
        ).run(playback.sessionId);
      } finally {
        db.close();
      }
    } else if (ending === "stopped")
      await server.api(path, { token: viewer.accessToken, method: "DELETE" });
    else
      await server.api(`/users/${user.id}`, {
        token,
        method: "PATCH",
        body: { libraryAccess: { scope: "selected", libraryIds: [] } },
      });
    const status = ending === "revoked-access" ? 403 : 409;
    await server.api(`${path}/heartbeat`, {
      token: viewer.accessToken,
      status,
      body: { state: "playing", activeTrackId: null, errorCode: null },
    });
    await server.api(`${path}/progress`, {
      token: viewer.accessToken,
      status,
      body: { trackId: itemId, positionMs: 3000, durationMs: 20000, sequence: 1 },
    });
    if (ending === "revoked-access") {
      const db = openDatabase(server.databasePath);
      try {
        db.prepare("UPDATE playback_grants SET expires_at_ms = 1 WHERE session_id = ?").run(
          playback.sessionId,
        );
      } finally {
        db.close();
      }
    }
    expect(
      (
        await server.request(playback.streamUrl, {
          headers: { authorization: `Bearer ${playback.grantToken}` },
        })
      ).status,
    ).toBe(404);
  });
