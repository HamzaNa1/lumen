import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, password, repository, test } from "./support/server";

test("scanned media streams exact bytes with scoped grants, range and conditional request semantics", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film (2019).mp4", "Other.mp4"]);
  const items = await server.items(token, library.id);
  expect(items).toHaveLength(2);
  const item = items.find((item) => item.title === "Film");
  expect(item).toBeDefined();
  const playback = await server.play(token, item?.id ?? "");
  const bytes = await readFile(join(repository, "tests/fixtures/playback.mp4"));
  const headers = { authorization: `Bearer ${playback.grantToken}` };
  const full = await server.request(playback.streamUrl, { headers });
  expect(full.status).toBe(200);
  expect(full.headers.get("content-length")).toBe(String(bytes.length));
  expect(full.headers.get("content-type")).toBe("video/mp4");
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  for (const [range, start, end] of [
    ["bytes=2-5", 2, 5],
    ["bytes=7-", 7, bytes.length - 1],
    ["bytes=-3", bytes.length - 3, bytes.length - 1],
    ["bytes=8-999999999999999999999", 8, bytes.length - 1],
    ["bytes=-999999999999999999999", 0, bytes.length - 1],
  ] as const) {
    const response = await server.request(playback.streamUrl, { headers: { ...headers, range } });
    expect(response.status, range).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
  }
  for (const range of [`bytes=${bytes.length}-`, "bytes=999999999999999999999-", "bytes=-0"])
    expect(
      (await server.request(playback.streamUrl, { headers: { ...headers, range } })).status,
      range,
    ).toBe(416);
  for (const range of ["bytes=5-1", "bytes=0-1,3-4", "bytes=abc", "items=0-1"])
    expect(
      (await server.request(playback.streamUrl, { headers: { ...headers, range } })).status,
      range,
    ).toBe(200);
  const head = await server.request(playback.streamUrl, {
    method: "HEAD",
    headers: { ...headers, range: "bytes=2-5" },
  });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(bytes.length));
  expect(await head.text()).toBe("");
  const etag = full.headers.get("etag") ?? "";
  expect(etag).not.toBe("");
  for (const [condition, status] of [
    [{ "if-none-match": etag }, 304],
    [{ "if-match": '"other"' }, 412],
    [{ "if-none-match": '"other"', "if-modified-since": "Thu, 01 Jan 2099 00:00:00 GMT" }, 200],
    [{ "if-unmodified-since": "Tue, 01 Jan 1980 00:00:00 GMT" }, 412],
  ] as const)
    expect(
      (await server.request(playback.streamUrl, { headers: { ...headers, ...condition } })).status,
    ).toBe(status);
  for (const [authorization, status] of [
    ["", 401],
    ["Bearer invalid", 404],
    [`Bearer ${token}`, 404],
  ] as const)
    expect((await server.request(playback.streamUrl, { headers: { authorization } })).status).toBe(
      status,
    );
  await server.api(`/playback/sessions/${playback.sessionId}`, { token, method: "DELETE" });
  expect((await server.request(playback.streamUrl, { headers })).status).toBe(404);
});

test("static app routing, MIME types, caching and CSP remain isolated from the API", async ({
  server,
}) => {
  const redirected = await server.request("/web?source=e2e", { redirect: "manual" });
  expect(redirected.status).toBe(308);
  expect(redirected.headers.get("location")).toBe("/web/?source=e2e");
  const html = await server.request("/web/");
  const source = await html.text();
  expect(source).toContain("<html");
  const policy = html.headers.get("content-security-policy");
  expect(policy).toContain("default-src 'self'");
  const forged = await server.request("/web/index.html", {
    headers: { "x-forwarded-host": "x; script-src *" },
  });
  expect(forged.headers.get("content-security-policy")).toBe(policy);
  for (const path of ["/web/search", "/web/settings", "/web/admin/users", "/web/library/unknown"])
    expect(await (await server.request(path)).text()).toBe(source);
  const asset = /(?:src|href)="(\/web\/assets\/[^" ]+\.js)"/.exec(source)?.[1];
  expect(asset).toBeDefined();
  const resource = await server.request(asset ?? "");
  expect(resource.status).toBe(200);
  expect(resource.headers.get("cache-control")).toContain("immutable");
  expect(resource.headers.get("content-type")).toMatch(/javascript/);
  const head = await server.request(asset ?? "", { method: "HEAD" });
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-length")).toBe(resource.headers.get("content-length"));
  expect(
    (
      await server.request(asset ?? "", {
        headers: { "if-none-match": resource.headers.get("etag") ?? "" },
      })
    ).status,
  ).toBe(304);
  expect((await server.request("/web/", { method: "POST" })).status).toBe(405);
  expect((await server.request("/web/assets/missing.js")).status).toBe(404);
  expect((await server.request("/api/v1/unknown")).headers.get("content-type")).not.toContain(
    "text/html",
  );
});

test("transcoding produces playable H264/AAC, supports offsets and retains grant isolation", async ({
  server,
  admin,
}, testInfo) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const item = (await server.items(admin.accessToken, library.id))[0];
  const playback = await server.play(admin.accessToken, item?.id ?? "");
  const url = `${playback.streamUrl}?transcode=1&video=copy&audio=copy&start=13`;
  expect((await server.request(url)).status).toBe(401);
  const headers = { authorization: `Bearer ${playback.grantToken}` };
  const response = await server.request(url, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("accept-ranges")).toBe("none");
  const output = testInfo.outputPath("transcoded.mp4");
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
  const metadata = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output], {
      encoding: "utf8",
    }),
  );
  expect(metadata.streams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual([
    "h264",
    "aac",
  ]);
  for (const stream of metadata.streams) {
    expect(Number(stream.duration)).toBeGreaterThan(6.9);
    expect(Number(stream.duration)).toBeLessThan(7.3);
  }
  await testInfo.attach("transcoded media", { path: output, contentType: "video/mp4" });
  expect(
    (await server.request(`${playback.streamUrl}?transcode=1&start=-1`, { headers })).status,
  ).toBe(400);
  await server.api(`/playback/sessions/${playback.sessionId}`, {
    token: admin.accessToken,
    method: "DELETE",
  });
  expect((await server.request(url, { headers })).status).toBe(404);
});

test("adaptive conversion cuts every quality and restart at the same source times", async ({
  server,
  admin,
}, testInfo) => {
  const library = await server.library(admin.accessToken, "movies", []);
  execFileSync("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24000/1001"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "18"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-g", "240", "-c:a", "aac"],
    join(library.path, "Wide.mkv"),
  ]);
  await server.scan(admin.accessToken, library.id);
  const item = (await server.items(admin.accessToken, library.id))[0];
  const playback = await server.play(admin.accessToken, item?.id ?? "");
  const base = `${playback.streamUrl}/adaptive/0`;
  const headers = { authorization: `Bearer ${playback.grantToken}` };
  expect((await server.request(`${base}/master.m3u8`)).status).toBe(401);

  const master = await (await server.request(`${base}/master.m3u8`, { headers })).text();
  expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio"');
  expect([...master.matchAll(/^(\d+p)\.m3u8$/gmu)].map((match) => match[1])).toEqual([
    "720p",
    "480p",
    "360p",
  ]);
  expect(master).toContain("RESOLUTION=640x360");
  // The browser cannot attach a bearer token to playlist entries, so the grant travels with them.
  const shared = await (
    await server.request(`${base}/master.m3u8?grant=${playback.grantToken}`)
  ).text();
  expect(shared).toContain(`720p.m3u8?grant=${playback.grantToken}`);
  const playlist = await (await server.request(`${base}/360p.m3u8`, { headers })).text();
  expect(playlist.match(/#EXTINF/gu)).toHaveLength(5);
  expect(playlist).toContain("#EXT-X-ENDLIST");
  expect((await server.request(`${base}/1080p.m3u8`, { headers })).status).toBe(404);
  expect((await server.request(`${base}/360p/5.ts`, { headers })).status).toBe(404);

  const piece = async (path: string) => {
    const response = await server.request(`${base}/${path}`, { headers });
    expect(response.status, path).toBe(200);
    const output = testInfo.outputPath(path.replace("/", "-"));
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          ...["-v", "error", "-show_entries", "stream=codec_name,height:packet=pts_time,flags"],
          ...["-of", "json", output],
        ],
        { encoding: "utf8" },
      ),
    ) as {
      streams: ReadonlyArray<{ codec_name: string; height?: number }>;
      packets: ReadonlyArray<{ pts_time: string; flags: string }>;
    };
    return {
      codecs: probe.streams.map((stream) => stream.codec_name),
      height: probe.streams[0]?.height,
      start: Number(probe.packets[0]?.pts_time),
      keyframes: probe.packets.filter((packet) => packet.flags.startsWith("K")).length,
    };
  };
  // Asking for piece 3 first starts the encoder there; piece 1 is behind it and restarts it.
  const late = await piece("720p/3.ts");
  const early = await piece("720p/1.ts");
  const other = await piece("360p/3.ts");
  const next = await piece("720p/2.ts");
  expect(late).toMatchObject({ codecs: ["h264"], height: 720, keyframes: 1 });
  expect(other).toMatchObject({ codecs: ["h264"], height: 360, keyframes: 1 });
  expect(other.start).toBe(late.start);
  expect(late.start - early.start).toBeCloseTo(8, 1);
  expect(late.start - next.start).toBeCloseTo(4, 1);
  const audio = await piece("audio/3.ts");
  expect(audio.codecs).toEqual(["aac"]);
  // Neither stream has a frame exactly on the cut: video starts at the first frame after it, and
  // audio at the frame that reaches it. Two video frames plus one audio frame bound the gap.
  expect(Math.abs(audio.start - late.start)).toBeLessThan(2 * (1001 / 24000) + 1024 / 48000);

  await server.api(`/playback/sessions/${playback.sessionId}`, {
    token: admin.accessToken,
    method: "DELETE",
  });
  expect((await server.request(`${base}/master.m3u8`, { headers })).status).toBe(404);
});

test.describe("transcoding disabled", () => {
  test("preserves direct play and rejects conversion", async ({ server, admin }) => {
    const settings = await server.api<Record<string, unknown>>("/admin/transcoding-settings", {
      token: admin.accessToken,
    });
    await server.api("/admin/transcoding-settings", {
      token: admin.accessToken,
      method: "PUT",
      body: { ...settings, enabled: false },
    });
    await server.api("/users", {
      token: admin.accessToken,
      body: { username: "viewer", displayName: "Viewer", password },
    });
    const viewer = await server.login("viewer");
    await server.api("/admin/transcoding-settings", { token: viewer.accessToken, status: 403 });
    await server.api("/admin/transcoding-settings", {
      token: viewer.accessToken,
      method: "PUT",
      body: settings,
      status: 403,
    });
    for (const patch of [
      { threads: 0 },
      { maxJobs: 129 },
      { encoder: "unknown" },
      { gpus: ["0", "0"] },
      { encoder: "vaapi", gpus: ["0"] },
      { ffmpeg: " " },
    ]) {
      await server.api("/admin/transcoding-settings", {
        token: admin.accessToken,
        method: "PUT",
        body: { ...settings, ...patch },
        status: 400,
      });
    }
    await server.restart();
    const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
    const item = (await server.items(admin.accessToken, library.id))[0];
    const playback = await server.play(admin.accessToken, item?.id ?? "");
    const headers = { authorization: `Bearer ${playback.grantToken}` };
    expect((await server.request(`${playback.streamUrl}?transcode=1`, { headers })).status).toBe(
      503,
    );
    expect(
      (await server.request(`${playback.streamUrl}/adaptive/0/master.m3u8`, { headers })).status,
    ).toBe(503);
    const direct = await server.request(playback.streamUrl, { headers });
    expect(direct.status).toBe(200);
    await direct.arrayBuffer();
  });
});

test.describe("transcoding resource ownership", () => {
  test("closing or disconnecting playback frees the encoder slot", async ({ server, admin }) => {
    const settings = await server.api<Record<string, unknown>>("/admin/transcoding-settings", {
      token: admin.accessToken,
    });
    await server.api("/admin/transcoding-settings", {
      token: admin.accessToken,
      method: "PUT",
      body: { ...settings, maxJobs: 1 },
    });
    const library = await server.library(admin.accessToken, "movies", []);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-stream_loop",
      "-1",
      "-i",
      join(repository, "tests/fixtures/playback.mp4"),
      "-t",
      "3600",
      "-c",
      "copy",
      join(library.path, "Long.mp4"),
    ]);
    await server.scan(admin.accessToken, library.id);
    const item = (await server.items(admin.accessToken, library.id))[0];
    const first = await server.play(admin.accessToken, item?.id ?? "");
    const second = await server.play(admin.accessToken, item?.id ?? "");
    const request = (playback: typeof first, signal?: AbortSignal) =>
      server.request(`${playback.streamUrl}?transcode=1&video=h264&audio=aac`, {
        headers: { authorization: `Bearer ${playback.grantToken}` },
        ...(signal === undefined ? {} : { signal }),
      });
    const abort = new AbortController();
    const response = await request(first, abort.signal);
    expect(response.status).toBe(200);
    expect((await request(second)).status).toBe(503);
    await server.api(`/playback/sessions/${first.sessionId}`, {
      token: admin.accessToken,
      method: "DELETE",
    });
    await expect
      .poll(async () => {
        const next = await request(second);
        await next.body?.cancel();
        return next.status;
      })
      .toBe(200);
    abort.abort();
    const third = await server.play(admin.accessToken, item?.id ?? "");
    await expect
      .poll(async () => {
        const next = await request(third);
        await next.body?.cancel();
        return next.status;
      })
      .toBe(200);
  });
});
