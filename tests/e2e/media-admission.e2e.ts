import { expect, test } from "./support/server";

test("concurrent viewers retain independent media allowances after API exhaustion and forged media aliases cannot bypass admission", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4"]);
  const id = (await server.items(token, library.id))[0]?.id ?? "";
  const first = await server.play(token, id);
  const second = await server.play((await server.login()).accessToken, id);
  await server.stop();
  await server.start({
    LUMEN_MAX_REQUESTS_PER_MINUTE: "1",
    LUMEN_MEDIA_BURST: "3",
    LUMEN_MEDIA_REQUESTS_PER_MINUTE: "1",
    LUMEN_MEDIA_PEER_REQUESTS_PER_MINUTE: "10000",
  });
  expect(
    (await server.request("/api/v1/libraries", { headers: { authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(429);
  const path = new URL(first.streamUrl, server.origin).pathname;
  const request = (grant: string, range: string) =>
    server.request(path, { headers: { authorization: `Bearer ${grant}`, range } });
  const burst = await Promise.all(
    Array.from({ length: 3 }, () => request(first.grantToken, "bytes=0-9")),
  );
  for (const response of burst) {
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(10);
  }
  expect((await request(first.grantToken, "bytes=0-9")).status).toBe(429);
  // The per-user ceiling also applies to another session of that user.
  expect((await request(second.grantToken, "bytes=0-9")).status).toBe(429);
  for (const alias of [`${path}/extra`, "/api/v1/media/", path.replace("/media/", "/media//")])
    expect(
      (
        await server.request(alias, {
          headers: {
            authorization: `Bearer ${first.grantToken}`,
            "x-forwarded-for": crypto.randomUUID(),
          },
        })
      ).status,
    ).toBe(429);
  expect((await server.request("/web/")).status).toBe(200);
  expect(server.log.join("")).not.toContain(first.grantToken);
});

for (const trusted of [false, true])
  test(`request budgets honor forwarded addresses only from trusted peers (${trusted})`, async ({
    server,
  }) => {
    await server.stop();
    await server.start({
      LUMEN_MAX_REQUESTS_PER_MINUTE: "2",
      ...(trusted ? { LUMEN_TRUSTED_PROXIES: "127.0.0.1" } : {}),
    });
    const request = (address: string) =>
      server.request("/health/live", { headers: { "x-forwarded-for": address } });
    expect((await request("203.0.113.1")).status).toBe(200);
    expect((await request("203.0.113.1")).status).toBe(trusted ? 200 : 429);
    expect((await request("203.0.113.2")).status).toBe(trusted ? 200 : 429);
    expect((await request("not-an-ip")).status).toBe(trusted ? 200 : 429);
  });
