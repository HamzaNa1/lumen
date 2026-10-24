import { expect, password, test } from "./support/server";

test("first-run registration, token validation, ACL changes and persistent server identity", async ({
  server,
}) => {
  expect(await server.api("/auth/setup")).toEqual({ setupRequired: true });
  const admin = await server.register();
  const token = admin.accessToken;
  expect(token.startsWith(`${admin.sessionId}.`)).toBe(true);
  expect(await server.api("/auth/setup")).toEqual({ setupRequired: false });
  await server.api("/auth/register", {
    status: 403,
    body: {
      username: "second",
      displayName: "Second",
      password,
      deviceId: crypto.randomUUID(),
      deviceName: "Test",
      platform: "desktop",
      platformDeviceId: null,
    },
  });
  for (const credential of [
    "",
    "invalid",
    `${admin.sessionId}.invalid`,
    token.toUpperCase(),
    `${token}=`,
    `${token}.extra`,
  ])
    await server.api("/auth/me", { token: credential, status: 401 });
  expect(await server.api("/auth/me", { token })).toMatchObject({ role: "admin" });
  const user = await server.api<{ id: string }>("/users", {
    token,
    body: { username: "viewer", displayName: "Viewer", password, role: "user" },
  });
  const viewer = await server.login("viewer");
  const library = await server.library(token, "movies", []);
  const other = await server.library(token, "shows", []);
  expect(await server.api("/libraries", { token: viewer.accessToken })).toEqual([]);
  for (const path of [
    "/users",
    "/admin/libraries",
    "/admin/jobs",
    `/items?libraryId=${library.id}`,
  ])
    await server.api(path, { token: viewer.accessToken, status: 403 });
  await server.api(`/users/${user.id}`, {
    token,
    method: "PATCH",
    body: { libraryAccess: { scope: "selected", libraryIds: [library.id] } },
  });
  expect(await server.api("/libraries", { token: viewer.accessToken })).toEqual([
    expect.objectContaining({ id: library.id }),
  ]);
  await server.api(`/items?libraryId=${other.id}`, { token: viewer.accessToken, status: 403 });
  await server.api(`/users/${user.id}`, {
    token,
    method: "PATCH",
    body: { libraryAccess: { scope: "all" } },
  });
  expect(await server.api("/libraries", { token: viewer.accessToken })).toHaveLength(2);
  await server.api(`/users/${user.id}`, {
    token,
    method: "PATCH",
    status: 400,
    body: { libraryAccess: { scope: "selected", libraryIds: [crypto.randomUUID()] } },
  });
  expect(await server.api("/libraries", { token: viewer.accessToken })).toHaveLength(2);
  await server.api("/admin/server", {
    token: viewer.accessToken,
    method: "PUT",
    status: 403,
    body: { displayName: "Forbidden" },
  });
  for (const displayName of [" ", "x".repeat(201)])
    await server.api("/admin/server", { token, method: "PUT", status: 400, body: { displayName } });
  await server.api("/admin/server", {
    token,
    method: "PUT",
    body: { displayName: "  Living room  " },
  });
  const identity = await server.api("/server");
  expect(identity).toMatchObject({ displayName: "Living room" });
  await server.restart();
  expect(await server.api("/server")).toEqual(identity);
  await server.api("/auth/me", { token });
  await server.api(`/users/${user.id}`, {
    token,
    method: "PATCH",
    body: { libraryAccess: { scope: "selected", libraryIds: [] } },
  });
  expect(await server.api("/libraries", { token: viewer.accessToken })).toEqual([]);
});

test("cookie sessions require CSRF proof, keep credentials private and revoke without clearing newer cookies", async ({
  server,
  admin,
}) => {
  const body = JSON.stringify({
    username: "admin",
    password,
    deviceId: crypto.randomUUID(),
    deviceName: "Browser",
  });
  const origin = new URL(server.origin).origin;
  const login = (headers: Record<string, string>) =>
    server.request("/api/v1/auth/browser/login", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  for (const headers of [
    {},
    { origin },
    { "x-lumen-csrf": "1" },
    { origin: "https://evil.example", "x-lumen-csrf": "1" },
  ])
    expect((await login(headers)).status).toBe(403);
  const response = await login({ origin, "x-lumen-csrf": "1" });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/api"])
    expect(cookie).toContain(attribute);
  expect(cookie).not.toContain("Domain=");
  const pair = cookie.split(";")[0] ?? "";
  const sessionBody = await response.text();
  expect(sessionBody).not.toContain("accessToken");
  expect(sessionBody).not.toContain(pair.split("=")[1] ?? "missing");
  const restored = await server.request("/api/v1/auth/browser/session", {
    headers: { cookie: pair },
  });
  expect(restored.status).toBe(200);
  expect(restored.headers.get("set-cookie")).toContain("Max-Age=");
  const mutate = (headers: Record<string, string>) =>
    server.request("/api/v1/auth/browser/logout", {
      method: "POST",
      headers: { cookie: pair, "content-type": "application/json", ...headers },
      body: "{}",
    });
  expect((await mutate({ origin: "https://evil.example", "x-lumen-csrf": "1" })).status).toBe(403);
  expect((await mutate({ origin, "x-lumen-csrf": "1" })).status).toBe(200);
  const revoked = await server.request("/api/v1/auth/browser/session", {
    headers: { cookie: pair },
  });
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get("set-cookie")).toBeNull();
  await server.api("/auth/me", { token: admin.accessToken });
});

for (const [setting, secure] of [
  ["always", true],
  ["never", false],
] as const)
  test(`cookie policy ${setting} survives real HTTP login`, async ({ server, admin }) => {
    expect(admin.accessToken).toBeTruthy();
    await server.stop();
    await server.start({ LUMEN_COOKIE_SECURE: setting });
    const response = await server.request("/api/v1/auth/browser/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(server.origin).origin,
        "x-lumen-csrf": "1",
      },
      body: JSON.stringify({
        username: "admin",
        password,
        deviceId: crypto.randomUUID(),
        deviceName: "Browser",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")?.includes("Secure")).toBe(secure);
  });
