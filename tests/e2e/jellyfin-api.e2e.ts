import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DecisionInput,
  decidePlayback,
} from "../../apps/server/src/jellyfin/PlaybackDecision";
import { parseVideoDetails } from "../../apps/server/src/jellyfin/Probe";
import { encode } from "./support/encode";
import { specProblems } from "./support/openapi";
import { expect, password, repository, type Server, test } from "./support/server";

const device = (deviceId: string, token?: string) =>
  `MediaBrowser Client="Findroid", Device="Pixel 8", DeviceId="${deviceId}", Version="0.15.0"${
    token === undefined ? "" : `, Token="${token}"`
  }`;

const dashed = (id: string) => id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, "$1-$2-$3-$4-$5");

interface Call {
  method?: string;
  body?: unknown;
  status?: number;
  /** The route in Jellyfin's document whose response this must match. */
  spec?: string;
}

class Jellyfin {
  constructor(
    readonly server: Server,
    readonly token: string,
    readonly userId: string,
  ) {}

  static async signIn(server: Server, username = "admin", deviceId = "device-1") {
    const response = await server.request("/jellyfin/Users/AuthenticateByName", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: device(deviceId) },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(specProblems("/Users/AuthenticateByName", "post", body)).toEqual([]);
    return new Jellyfin(server, body.AccessToken, body.User.Id);
  }

  // biome-ignore lint/suspicious/noExplicitAny: responses are checked against Jellyfin's document.
  async call(path: string, { method = "GET", body, status = 200, spec }: Call = {}): Promise<any> {
    const response = await this.server.request(`/jellyfin${path}`, {
      method,
      headers: {
        authorization: device("device-1", this.token),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(response.status, `${method} ${path}: ${text}`).toBe(status);
    const parsed = text === "" ? null : JSON.parse(text);
    if (spec !== undefined) expect(specProblems(spec, method, parsed), path).toEqual([]);
    return parsed;
  }
}

/** A 720p film with stereo AAC and an embedded SubRip track: streams 0, 1 and 2. */
const film = async (server: Server, token: string) => {
  const subtitles = join(server.root, `${crypto.randomUUID()}.srt`);
  await writeFile(subtitles, "1\n00:00:00,500 --> 00:00:03,000\nHello from Lumen\n");
  const library = await server.library(token, "movies", []);
  await encode(
    [
      ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-i", subtitles, "-t", "9"],
      ...["-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx264", "-preset", "ultrafast"],
      ...["-c:a", "aac", "-c:s", "srt"],
    ],
    join(library.path, "Film.mkv"),
  );
  await server.scan(token, library.id);
  const item = (await server.items(token, library.id))[0];
  if (item === undefined) throw new Error("The film was not scanned");
  return { library, id: item.id.replaceAll("-", "") };
};

test("Jellyfin apps connect, sign in and browse with responses Jellyfin 12.4 apps can read", async ({
  server,
  admin,
}) => {
  const movies = await server.library(
    admin.accessToken,
    "movies",
    ["Film (2019)/Film (2019).mp4"],
    {
      "Film (2019)/poster.png": "still.png",
    },
  );
  const shows = await server.library(admin.accessToken, "shows", [
    "Serial (2021)/Season 1/Serial S01E01 - Pilot.mp4",
    "Serial (2021)/Season 1/Serial S01E02 - Second.mp4",
  ]);
  await server.library(admin.accessToken, "music", []);

  const info = await server.request("/jellyfin/system/info/PUBLIC");
  const publicInfo = await info.json();
  expect(specProblems("/System/Info/Public", "get", publicInfo)).toEqual([]);
  expect(publicInfo).toMatchObject({
    ProductName: "Jellyfin Server",
    Version: "12.4.0",
    StartupWizardCompleted: true,
  });
  expect((await server.request("/jellyfin/System/Info")).status).toBe(401);

  const jellyfin = await Jellyfin.signIn(server);
  expect(dashed(jellyfin.userId)).toBe(admin.userId);
  const devices = await server.api<{ name: string }[]>(`/users/${admin.userId}/devices`, {
    token: admin.accessToken,
  });
  expect(devices.map((entry) => entry.name)).toContain("Pixel 8 (Jellyfin)");

  const browser = await server.request("/api/v1/auth/browser/login", {
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
  const cookie = browser.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  expect(cookie).toContain("=");
  const me = (path: string, headers: Record<string, string>) =>
    server.request(`/jellyfin${path}`, { headers });
  for (const [path, headers] of [
    ["/Users/Me", { authorization: device("device-1", jellyfin.token) }],
    ["/Users/Me", { "x-emby-authorization": device("device-1", jellyfin.token) }],
    ["/Users/Me", { "x-emby-token": jellyfin.token }],
    ["/Users/Me", { "x-mediabrowser-token": jellyfin.token }],
    [`/Users/Me?api_key=${jellyfin.token}`, {}],
    [`/Users/Me?ApiKey=${jellyfin.token}`, {}],
  ] as const)
    expect((await me(path, headers)).status, JSON.stringify(headers)).toBe(200);
  // The web app's cookie and the desktop's bearer token are not Jellyfin credentials.
  expect((await me("/Users/Me", { cookie })).status).toBe(401);
  expect((await me("/Users/Me", { authorization: `Bearer ${admin.accessToken}` })).status).toBe(
    401,
  );

  const user = await jellyfin.call("/Users/Me", { spec: "/Users/Me" });
  expect(user.Policy).toMatchObject({ IsAdministrator: false, EnableContentDownloading: true });
  await jellyfin.call(`/Users/${jellyfin.userId}`, { spec: "/Users/{userId}" });
  const stranger = crypto.randomUUID().replaceAll("-", "");
  await jellyfin.call(`/Users/${stranger}`, { status: 403 });
  await jellyfin.call(`/Users/${stranger}/Items?Recursive=true`, { status: 403 });
  await jellyfin.call(`/Items?userId=${stranger}`, { status: 403 });
  // Apps set to automatic quality time this download before they ask to play anything.
  const bitrate = await server.request("/jellyfin/Playback/BitrateTest?size=300000", {
    headers: { "x-emby-token": jellyfin.token },
  });
  expect(bitrate.status).toBe(200);
  expect((await bitrate.arrayBuffer()).byteLength).toBe(300_000);
  expect((await server.request("/jellyfin/Playback/BitrateTest?size=300000")).status).toBe(401);
  await jellyfin.call("/Playback/BitrateTest?size=0", { status: 400 });
  await jellyfin.call("/DisplayPreferences/usersettings?client=emby", {
    spec: "/DisplayPreferences/{displayPreferencesId}",
  });

  const views = await jellyfin.call("/UserViews", { spec: "/UserViews" });
  expect(views.Items.map((view: { CollectionType: string }) => view.CollectionType)).toEqual([
    "movies",
    "tvshows",
  ]);
  const movieList = await jellyfin.call(
    `/Items?ParentId=${movies.id.replaceAll("-", "")}&IncludeItemTypes=Movie&Recursive=true&SortBy=SortName&Fields=MediaSources`,
    { spec: "/Items" },
  );
  expect(movieList.TotalRecordCount).toBe(1);
  const movie = movieList.Items[0];
  expect(movie).toMatchObject({ Name: "Film", Type: "Movie", ProductionYear: 2019 });
  expect(movie.MediaSources[0].MediaStreams.length).toBeGreaterThan(0);
  const tag = movie.ImageTags.Primary;
  expect(tag).toMatch(/^[0-9a-f]{64}$/u);
  const detail = await jellyfin.call(`/Items/${movie.Id}`, { spec: "/Items/{itemId}" });
  expect(detail.MediaSources).toHaveLength(1);
  expect((await jellyfin.call(`/Users/${jellyfin.userId}/Items/${movie.Id}`)).Id).toBe(movie.Id);

  // Apps fetch images without credentials, and Fladder without a tag, so naming the item is enough.
  const image = (query: string, headers: Record<string, string> = {}, id = movie.Id) =>
    server.request(`/jellyfin/Items/${id}/Images/Primary${query}`, { headers });
  const tagged = await image(`?tag=${tag}&maxWidth=200`);
  expect(tagged.status).toBe(200);
  expect(tagged.headers.get("content-type")).toBe("image/png");
  expect(tagged.headers.get("cache-control")).toContain("immutable");
  for (const query of ["?quality=90&fillWidth=256&fillHeight=384", `?tag=${"0".repeat(64)}`]) {
    const untagged = await image(query);
    expect(untagged.status, query).toBe(200);
    expect(untagged.headers.get("cache-control"), query).not.toContain("immutable");
  }
  expect((await image("", {}, crypto.randomUUID().replaceAll("-", ""))).status).toBe(404);
  expect((await image("", { "x-emby-token": jellyfin.token })).status).toBe(200);
  const backdrop = await server.request(`/jellyfin/Items/${movie.Id}/Images/Backdrop`, {
    headers: { "x-emby-token": jellyfin.token },
  });
  expect(backdrop.status).toBe(404);

  const series = (
    await jellyfin.call(
      `/Items?ParentId=${shows.id.replaceAll("-", "")}&IncludeItemTypes=Series&Recursive=true`,
      { spec: "/Items" },
    )
  ).Items[0];
  expect(series).toMatchObject({ Name: "Serial", Type: "Series", IsFolder: true });
  const seasons = await jellyfin.call(`/Shows/${series.Id}/Seasons`, {
    spec: "/Shows/{seriesId}/Seasons",
  });
  expect(seasons.Items).toHaveLength(1);
  const episodes = await jellyfin.call(
    `/Shows/${series.Id}/Episodes?SeasonId=${seasons.Items[0].Id}`,
    { spec: "/Shows/{seriesId}/Episodes" },
  );
  expect(
    episodes.Items.map((episode: { IndexNumber: number; ParentIndexNumber: number }) => [
      episode.ParentIndexNumber,
      episode.IndexNumber,
    ]),
  ).toEqual([
    [1, 1],
    [1, 2],
  ]);
  const page = await jellyfin.call(`/Shows/${series.Id}/Episodes?StartIndex=1&Limit=1`);
  expect(page).toMatchObject({ TotalRecordCount: 2, StartIndex: 1, Items: [{ IndexNumber: 2 }] });
  const found = await jellyfin.call(
    "/Items?SearchTerm=seri&Recursive=true&IncludeItemTypes=Movie,Series",
  );
  expect(found.Items.map((entry: { Name: string }) => entry.Name)).toEqual(["Serial"]);
  const latest = await jellyfin.call(`/Items/Latest?ParentId=${shows.id.replaceAll("-", "")}`, {
    spec: "/Items/Latest",
  });
  expect(latest.map((entry: { Id: string }) => entry.Id)).toEqual([series.Id]);

  const [first, second] = episodes.Items;
  const played = await jellyfin.call(`/UserPlayedItems/${first.Id}`, {
    method: "POST",
    spec: "/UserPlayedItems/{itemId}",
  });
  expect(played).toMatchObject({ Played: true, PlayCount: 1 });
  const nextUp = await jellyfin.call(`/Shows/NextUp?SeriesId=${series.Id}`, {
    spec: "/Shows/NextUp",
  });
  expect(nextUp.Items.map((entry: { Id: string }) => entry.Id)).toEqual([second.Id]);
  expect((await jellyfin.call("/Shows/NextUp")).Items[0].Id).toBe(second.Id);
  await jellyfin.call(`/UserPlayedItems/${first.Id}`, {
    method: "DELETE",
    spec: "/UserPlayedItems/{itemId}",
  });
  expect((await jellyfin.call(`/Items/${first.Id}`)).UserData.Played).toBe(false);
  await jellyfin.call("/UserItems/Resume", { spec: "/UserItems/Resume" });
});

test("a viewer without access to a library gets nothing from it", async ({ server, admin }) => {
  const movie = await film(server, admin.accessToken);
  await server.api("/users", {
    token: admin.accessToken,
    body: { username: "viewer", displayName: "Viewer", password },
  });
  // The same app installation signs in a second account as its own device.
  const viewer = await Jellyfin.signIn(server, "viewer", "device-1");
  expect((await viewer.call("/UserViews")).Items).toEqual([]);
  expect((await viewer.call("/Items?Recursive=true")).TotalRecordCount).toBe(0);
  await viewer.call(`/Items/${movie.id}`, { status: 404 });
  await viewer.call(`/Items/${movie.id}/PlaybackInfo`, { method: "POST", body: {}, status: 404 });
  await viewer.call(`/UserPlayedItems/${movie.id}`, { method: "POST", status: 404 });
  for (const path of [
    `/Videos/${movie.id}/stream?static=true`,
    `/Videos/${movie.id}/adaptive/0/master.m3u8`,
    `/Videos/${movie.id}/${movie.id}/Subtitles/2/0/Stream.vtt`,
    `/Items/${movie.id}/Images/Primary`,
  ])
    await viewer.call(path, { status: 404 });
});

test("direct play streams the file and reports progress and track choices to Lumen", async ({
  server,
  admin,
}) => {
  const movie = await film(server, admin.accessToken);
  const jellyfin = await Jellyfin.signIn(server);
  const info = await jellyfin.call(`/Items/${movie.id}/PlaybackInfo`, {
    method: "POST",
    spec: "/Items/{itemId}/PlaybackInfo",
    body: {
      UserId: jellyfin.userId,
      MaxStreamingBitrate: 120_000_000,
      DeviceProfile: {
        DirectPlayProfiles: [
          {
            Container: "mp4,matroska",
            VideoCodec: "h264,hevc",
            AudioCodec: "aac,ac3",
            Type: "Video",
          },
        ],
        CodecProfiles: [
          {
            Type: "Video",
            Codec: "h264",
            Conditions: [
              { Condition: "LessThanEqual", Property: "Width", Value: "1920", IsRequired: false },
              {
                Condition: "LessThanEqual",
                Property: "VideoLevel",
                Value: "51",
                IsRequired: false,
              },
            ],
          },
        ],
        SubtitleProfiles: [{ Format: "srt", Method: "Embed" }],
      },
    },
  });
  const [source] = info.MediaSources;
  expect(source).toMatchObject({ SupportsDirectPlay: true, Container: "mkv" });
  expect(source.TranscodingUrl).toBeUndefined();
  expect(
    source.MediaStreams.map((stream: { Type: string; Index: number }) => [
      stream.Type,
      stream.Index,
    ]),
  ).toEqual([
    ["Video", 0],
    ["Audio", 1],
    ["Subtitle", 2],
  ]);
  expect(source.MediaStreams[2]).toMatchObject({
    DeliveryMethod: "Embed",
    IsTextSubtitleStream: true,
  });
  const playSessionId = info.PlaySessionId;

  const range = await server.request(
    `/jellyfin/Videos/${movie.id}/stream?static=true&api_key=${jellyfin.token}&PlaySessionId=${playSessionId}`,
    { headers: { range: "bytes=0-99" } },
  );
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toMatch(/^bytes 0-99\//u);
  expect((await range.arrayBuffer()).byteLength).toBe(100);

  const report = { ItemId: movie.id, PlaySessionId: playSessionId, MediaSourceId: movie.id };
  await jellyfin.call("/Sessions/Playing", {
    method: "POST",
    body: { ...report, PositionTicks: 0, AudioStreamIndex: 1, SubtitleStreamIndex: -1 },
    status: 204,
  });
  await jellyfin.call("/Sessions/Playing/Progress", {
    method: "POST",
    body: {
      ...report,
      PositionTicks: 30_000_000,
      IsPaused: true,
      AudioStreamIndex: 1,
      SubtitleStreamIndex: 2,
    },
    status: 204,
  });
  const native = (id: string) =>
    server.api<{ watchState: { positionSeconds: number } }>(`/items/${dashed(id)}`, {
      token: admin.accessToken,
    });
  expect((await native(movie.id)).watchState.positionSeconds).toBe(3);
  const resume = await jellyfin.call("/UserItems/Resume", { spec: "/UserItems/Resume" });
  expect(resume.Items).toEqual([
    expect.objectContaining({
      Id: movie.id,
      UserData: expect.objectContaining({ PlaybackPositionTicks: 30_000_000 }),
    }),
  ]);

  // A subtitle chosen in a Jellyfin app is what Lumen's own players pick next time.
  const memory = async () => {
    const started = await server.api<{
      sessionId: string;
      streams: { id: string; kind: string }[];
      trackMemory: { subtitle: { streamId: string } | "off" | null };
    }>("/playback/sessions", { token: admin.accessToken, body: { trackId: dashed(movie.id) } });
    await server.api(`/playback/sessions/${started.sessionId}`, {
      token: admin.accessToken,
      method: "DELETE",
    });
    return started;
  };
  const chosen = await memory();
  expect(chosen.trackMemory.subtitle).toMatchObject({
    streamId: chosen.streams.find((stream) => stream.kind === "subtitle")?.id,
  });
  await jellyfin.call("/Sessions/Playing/Progress", {
    method: "POST",
    body: { ...report, PositionTicks: 35_000_000, AudioStreamIndex: 1, SubtitleStreamIndex: -1 },
    status: 204,
  });
  expect((await memory()).trackMemory.subtitle).toBe("off");

  await jellyfin.call(`/Sessions/Playing/Ping?playSessionId=${playSessionId}`, {
    method: "POST",
    status: 204,
  });
  // A server restart forgets the playback; the app's next report still counts.
  await server.restart();
  await jellyfin.call("/Sessions/Playing/Progress", {
    method: "POST",
    body: { ...report, PositionTicks: 50_000_000, AudioStreamIndex: 1, SubtitleStreamIndex: -1 },
    status: 204,
  });
  expect((await native(movie.id)).watchState.positionSeconds).toBe(5);
  await jellyfin.call("/Sessions/Playing/Stopped", {
    method: "POST",
    body: { ...report, PositionTicks: 40_000_000 },
    status: 204,
  });
  expect((await native(movie.id)).watchState.positionSeconds).toBe(4);

  // Asking again for a subtitle, as apps do to switch tracks, remembers it as well.
  await jellyfin.call(`/Items/${movie.id}/PlaybackInfo`, {
    method: "POST",
    body: { SubtitleStreamIndex: 2 },
  });
  expect((await memory()).trackMemory.subtitle).toMatchObject({
    streamId: chosen.streams.find((stream) => stream.kind === "subtitle")?.id,
  });
});

test("conversion follows the bitrate cap, delivers text subtitles and stops with playback", async ({
  server,
  admin,
}) => {
  const movie = await film(server, admin.accessToken);
  const jellyfin = await Jellyfin.signIn(server);
  const incompatible = {
    DirectPlayProfiles: [
      { Container: "mp4", VideoCodec: "hevc", AudioCodec: "aac", Type: "Video" },
    ],
    SubtitleProfiles: [
      { Format: "vtt", Method: "External" },
      { Format: "srt", Method: "External" },
    ],
  };
  const info = await jellyfin.call(`/Items/${movie.id}/PlaybackInfo`, {
    method: "POST",
    spec: "/Items/{itemId}/PlaybackInfo",
    body: { MaxStreamingBitrate: 3_000_000, DeviceProfile: incompatible },
  });
  const [source] = info.MediaSources;
  expect(source).toMatchObject({
    SupportsDirectPlay: false,
    SupportsTranscoding: true,
    TranscodingSubProtocol: "hls",
    TranscodingContainer: "ts",
    DefaultAudioStreamIndex: 1,
  });
  expect(source.TranscodingUrl).toMatch(/^\/Videos\/[0-9a-f]{32}\/adaptive\/0\/master\.m3u8\?/u);

  // Players fetch the playlists and pieces with the credentials the URLs carry.
  const master = await (await server.request(`/jellyfin${source.TranscodingUrl}`)).text();
  expect([...master.matchAll(/^(\d+p)\.m3u8\?api_key=/gmu)].map((match) => match[1])).toEqual([
    "480p",
    "360p",
  ]);
  const base = `/jellyfin/Videos/${movie.id}/adaptive/0`;
  const query = source.TranscodingUrl.split("?")[1];
  const playlist = await server.request(`${base}/480p.m3u8?${query}`);
  expect(await playlist.text()).toContain(`480p/0.ts?api_key=`);
  expect((await server.request(`${base}/720p.m3u8?${query}`)).status).toBe(404);
  const piece = await server.request(`${base}/480p/0.ts?${query}`);
  expect(piece.status).toBe(200);
  expect(piece.headers.get("content-type")).toBe("video/mp2t");
  await piece.arrayBuffer();
  const pieces = join(server.root, "transcode", `${admin.userId}-${dashed(info.PlaySessionId)}-0`);
  expect(existsSync(pieces)).toBe(true);

  const subtitle = source.MediaStreams.find(
    (stream: { Type: string }) => stream.Type === "Subtitle",
  );
  expect(subtitle).toMatchObject({ DeliveryMethod: "External", Index: 2 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const vtt = await server.request(`/jellyfin${subtitle.DeliveryUrl}`);
    expect(vtt.status).toBe(200);
    expect(vtt.headers.get("content-type")).toContain("text/vtt");
    const text = await vtt.text();
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).toContain("Hello from Lumen");
  }
  const srt = await server.request(
    `/jellyfin${subtitle.DeliveryUrl.replace("Stream.vtt", "Stream.srt")}`,
  );
  // FFmpeg builds differ in how they offset for the AAC encoder's start delay, by up to a frame.
  const cue =
    /(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})\s+Hello from Lumen/u.exec(
      await srt.text(),
    );
  const seconds = (parts: ReadonlyArray<string | undefined>) => {
    const [hours, minutes, whole, millis] = parts.map(Number);
    return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (whole ?? 0) + (millis ?? 0) / 1000;
  };
  expect(cue).not.toBeNull();
  expect(seconds(cue?.slice(1, 5) ?? [])).toBeCloseTo(0.5, 1);
  expect(seconds(cue?.slice(5, 9) ?? [])).toBeCloseTo(3, 1);
  expect(
    (await server.request(`/jellyfin${subtitle.DeliveryUrl.replace("Stream.vtt", "Stream.ass")}`))
      .status,
  ).toBe(400);

  // A lower quality is a new PlaybackInfo, which ends the device's earlier conversion. Some
  // apps send their cap only inside the device profile.
  const lower = await jellyfin.call(`/Items/${movie.id}/PlaybackInfo`, {
    method: "POST",
    body: { DeviceProfile: { ...incompatible, MaxStreamingBitrate: 1_000_000 } },
  });
  await expect.poll(() => existsSync(pieces)).toBe(false);
  const lowerUrl = lower.MediaSources[0].TranscodingUrl;
  const lowerMaster = await (await server.request(`/jellyfin${lowerUrl}`)).text();
  expect([...lowerMaster.matchAll(/^(\d+p)\.m3u8/gmu)].map((match) => match[1])).toEqual(["360p"]);
  const lowerPiece = await server.request(`${base}/360p/0.ts?${lowerUrl.split("?")[1]}`);
  expect(lowerPiece.status).toBe(200);
  await lowerPiece.arrayBuffer();
  const lowerPieces = join(
    server.root,
    "transcode",
    `${admin.userId}-${dashed(lower.PlaySessionId)}-0`,
  );
  expect(existsSync(lowerPieces)).toBe(true);
  await jellyfin.call("/Sessions/Playing/Stopped", {
    method: "POST",
    body: { ItemId: movie.id, PlaySessionId: lower.PlaySessionId, PositionTicks: 10_000_000 },
    status: 204,
  });
  await expect.poll(() => existsSync(lowerPieces)).toBe(false);

  const settings = await server.api<Record<string, unknown>>("/admin/transcoding-settings", {
    token: admin.accessToken,
  });
  await server.api("/admin/transcoding-settings", {
    token: admin.accessToken,
    method: "PUT",
    body: { ...settings, enabled: false },
  });
  const refused = await jellyfin.call(`/Items/${movie.id}/PlaybackInfo`, {
    method: "POST",
    spec: "/Items/{itemId}/PlaybackInfo",
    body: { DeviceProfile: incompatible },
  });
  expect(refused).toMatchObject({ ErrorCode: "NoCompatibleStream" });
  expect(refused.PlaySessionId).toBeUndefined();
  const direct = await jellyfin.call(`/Items/${movie.id}/PlaybackInfo`, {
    method: "POST",
    body: {},
  });
  expect(direct.MediaSources[0]).toMatchObject({
    SupportsDirectPlay: true,
    SupportsTranscoding: false,
  });
});

test("probed video details decide direct play for the profiles apps send", async ({
  server,
  admin,
}) => {
  const library = await server.library(admin.accessToken, "movies", []);
  const source = [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3"],
  ];
  await encode(
    [
      ...source,
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-x265-params",
      "log-level=error",
    ].concat(["-c:a", "aac"]),
    join(library.path, "Hevc.mkv"),
  );
  await encode(
    [...source, "-c:v", "libx264", "-preset", "ultrafast", "-x264-params"].concat([
      "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
      "-c:a",
      "aac",
    ]),
    join(library.path, "Hdr.mkv"),
  );
  await server.scan(admin.accessToken, library.id);
  const items = await server.items(admin.accessToken, library.id);
  const id = (title: string) => items.find((item) => item.title === title)?.id.replaceAll("-", "");
  const profile = async (app: string) =>
    JSON.parse(
      await readFile(join(repository, `tests/fixtures/jellyfin-${app}-profile.json`), "utf8"),
    );
  const jellyfin = await Jellyfin.signIn(server);
  const play = async (itemId: string | undefined, DeviceProfile: unknown) => {
    const info = await jellyfin.call(`/Items/${itemId}/PlaybackInfo`, {
      method: "POST",
      spec: "/Items/{itemId}/PlaybackInfo",
      body: { MaxStreamingBitrate: 120_000_000, DeviceProfile },
    });
    const [media] = info.MediaSources;
    return {
      media,
      video: media.MediaStreams.find((stream: { Type: string }) => stream.Type === "Video"),
    };
  };
  // Moonfin plays HEVC directly only when the server knows the profile.
  const hevc = await play(id("Hevc"), await profile("moonfin"));
  expect(hevc.media.SupportsDirectPlay).toBe(true);
  expect(hevc.video).toMatchObject({ Profile: "Main", BitDepth: 8, VideoRangeType: "SDR" });
  // Swiftfin plays H.264 directly only when it is SDR.
  const hdr = await play(id("Hdr"), await profile("swiftfin"));
  expect(hdr.media).toMatchObject({ SupportsDirectPlay: false, SupportsTranscoding: true });
  expect(hdr.video).toMatchObject({ VideoRange: "HDR", VideoRangeType: "HDR10" });
});

test("video details are read from ffprobe as Jellyfin names them", () => {
  const read = (stream: Record<string, unknown>) =>
    parseVideoDetails({ streams: [{ codec_type: "video", ...stream }] });
  expect(
    read({ profile: "Main 10", level: 153, pix_fmt: "yuv420p10le", color_transfer: "smpte2084" }),
  ).toMatchObject({ profile: "Main 10", level: 153, bitDepth: 10, rangeType: "HDR10" });
  expect(read({ color_transfer: "arib-std-b67" })?.rangeType).toBe("HLG");
  for (const [compatibility, rangeType] of [
    [0, "DOVI"],
    [1, "DOVIWithHDR10"],
    [2, "DOVIWithSDR"],
    [4, "DOVIWithHLG"],
  ] as const)
    expect(
      read({
        color_transfer: "smpte2084",
        side_data_list: [
          {
            side_data_type: "DOVI configuration record",
            dv_bl_signal_compatibility_id: compatibility,
          },
        ],
      })?.rangeType,
    ).toBe(rangeType);
  expect(
    read({ field_order: "tt", sample_aspect_ratio: "4:3", refs: 4, avg_frame_rate: "24000/1001" }),
  ).toMatchObject({ interlaced: true, anamorphic: true, refFrames: 4, frameRate: 23.976 });
  expect(
    read({ field_order: "progressive", sample_aspect_ratio: "1:1", pix_fmt: "yuv420p" }),
  ).toMatchObject({ interlaced: false, anamorphic: false, bitDepth: 8, rangeType: "SDR" });
  expect(read({ field_order: "unknown" })).toMatchObject({ interlaced: null, bitDepth: null });
  expect(parseVideoDetails({ streams: [{ codec_type: "audio" }] })).toBeNull();
});

test("playback decisions follow the device profile", async () => {
  const base: DecisionInput = {
    container: "mkv",
    bitrate: 8_000_000,
    video: { codec: "h264", width: 1920, height: 1080, bitrate: 7_500_000 },
    audio: { codec: "aac", channels: 2, bitrate: 192_000 },
    subtitles: [
      { index: 2, codec: "subrip" },
      { index: 3, codec: "hdmv_pgs_subtitle" },
      { index: 4, codec: "ass" },
    ],
    profile: null,
    maxStreamingBitrate: null,
    enableDirectPlay: true,
    enableTranscoding: true,
    canConvert: true,
  };
  const direct = (overrides: Partial<NonNullable<DecisionInput["profile"]>> = {}) => ({
    DirectPlayProfiles: [
      { Container: "matroska,mp4", VideoCodec: "h264", AudioCodec: "aac", Type: "Video" },
    ],
    ...overrides,
  });
  const cases: ReadonlyArray<[string, Partial<DecisionInput>, string, Record<number, string>?]> = [
    ["no profile plays the file", {}, "DirectPlay", { 2: "Embed", 3: "Embed", 4: "Embed" }],
    ["matroska names mkv", { profile: direct() }, "DirectPlay"],
    [
      "mov names mp4",
      {
        container: "mp4",
        profile: direct({ DirectPlayProfiles: [{ Container: "mov", Type: "Video" }] }),
      },
      "DirectPlay",
    ],
    [
      "an empty codec list allows any",
      {
        profile: direct({
          DirectPlayProfiles: [
            { Container: "mkv", VideoCodec: "", AudioCodec: null, Type: "Video" },
          ],
        }),
      },
      "DirectPlay",
    ],
    [
      "an audio codec it cannot play converts",
      { audio: { codec: "dts", channels: 6, bitrate: null }, profile: direct() },
      "Transcode",
    ],
    [
      "dca names dts",
      {
        audio: { codec: "dts", channels: 6, bitrate: null },
        profile: direct({
          DirectPlayProfiles: [{ Container: "mkv", AudioCodec: "dca", Type: "Video" }],
        }),
      },
      "DirectPlay",
    ],
    [
      "an audio-only profile plays no video",
      { profile: direct({ DirectPlayProfiles: [{ Container: "mkv", Type: "Audio" }] }) },
      "Transcode",
    ],
    [
      "no direct play profiles at all converts",
      { profile: direct({ DirectPlayProfiles: [] }) },
      "Transcode",
    ],
    ["over the cap converts", { maxStreamingBitrate: 4_000_000 }, "Transcode"],
    [
      "an unknown bitrate fits any cap",
      { bitrate: null, maxStreamingBitrate: 1_000 },
      "DirectPlay",
    ],
    [
      "the profile's cap applies when the request has none",
      { profile: direct({ MaxStreamingBitrate: 2_000_000 }) },
      "Transcode",
    ],
    [
      "direct play turned off converts",
      { enableDirectPlay: false },
      "Transcode",
      { 2: "External", 3: "Drop", 4: "External" },
    ],
    [
      "a width condition",
      {
        profile: direct({
          CodecProfiles: [
            {
              Type: "Video",
              Codec: "h264",
              Conditions: [
                { Condition: "LessThanEqual", Property: "Width", Value: "1280", IsRequired: false },
              ],
            },
          ],
        }),
      },
      "Transcode",
    ],
    [
      "a condition on another codec",
      {
        profile: direct({
          CodecProfiles: [
            {
              Type: "Video",
              Codec: "hevc",
              Conditions: [{ Condition: "LessThanEqual", Property: "Width", Value: "1280" }],
            },
          ],
        }),
      },
      "DirectPlay",
    ],
    [
      "an apply condition that does not hold",
      {
        profile: direct({
          CodecProfiles: [
            {
              Type: "Video",
              ApplyConditions: [
                { Condition: "GreaterThanEqual", Property: "Height", Value: "2160" },
              ],
              Conditions: [{ Condition: "Equals", Property: "Width", Value: "1" }],
            },
          ],
        }),
      },
      "DirectPlay",
    ],
    [
      "channels for audio",
      {
        profile: direct({
          CodecProfiles: [
            {
              Type: "VideoAudio",
              Codec: "aac",
              Conditions: [
                {
                  Condition: "LessThanEqual",
                  Property: "AudioChannels",
                  Value: "1",
                  IsRequired: false,
                },
              ],
            },
          ],
        }),
      },
      "Transcode",
    ],
    [
      "an unknown field passes",
      {
        profile: direct({
          CodecProfiles: [
            {
              Type: "Video",
              Conditions: [
                {
                  Condition: "EqualsAny",
                  Property: "VideoProfile",
                  Value: "high|main",
                  IsRequired: false,
                },
              ],
            },
          ],
        }),
      },
      "DirectPlay",
    ],
    [
      "an unknown field that is required fails",
      {
        profile: direct({
          CodecProfiles: [
            {
              Type: "Video",
              Conditions: [
                {
                  Condition: "EqualsAny",
                  Property: "VideoProfile",
                  Value: "high|main",
                  IsRequired: true,
                },
              ],
            },
          ],
        }),
      },
      "Transcode",
    ],
    [
      "nothing playable and no encoder",
      { enableDirectPlay: false, canConvert: false },
      "NoCompatibleStream",
    ],
    [
      "nothing playable and transcoding refused by the app",
      { enableDirectPlay: false, enableTranscoding: false },
      "NoCompatibleStream",
    ],
    [
      "subtitles the app only takes as files",
      {
        profile: direct({
          SubtitleProfiles: [
            { Format: "srt", Method: "External" },
            { Format: "pgssub", Method: "Embed" },
          ],
        }),
      },
      "DirectPlay",
      { 2: "External", 3: "Embed", 4: "External" },
    ],
  ];
  for (const [name, overrides, kind, subtitles] of cases) {
    const decision = decidePlayback({ ...base, ...overrides });
    expect(decision.kind, name).toBe(kind);
    if (subtitles !== undefined && decision.kind !== "NoCompatibleStream")
      expect(
        Object.fromEntries([...decision.subtitles].map(([index, plan]) => [index, plan.method])),
        name,
      ).toEqual(subtitles);
  }
  // The profile Swiftfin sent from an iPhone, which once ruled out direct play for every file.
  const swiftfin = JSON.parse(
    await readFile(join(repository, "tests/fixtures/jellyfin-swiftfin-profile.json"), "utf8"),
  );
  const film1080 = {
    ...base,
    bitrate: 4_890_422,
    audio: { codec: "eac3", channels: 6, bitrate: 640_000 },
    profile: swiftfin,
    maxStreamingBitrate: swiftfin.MaxStreamingBitrate,
  };
  expect(decidePlayback(film1080)).toMatchObject({ kind: "DirectPlay" });
  const range = (Value: string, Condition = "EqualsAny") =>
    decidePlayback({
      ...base,
      profile: direct({
        CodecProfiles: [
          {
            Type: "Video",
            Codec: "h264",
            Conditions: [{ Condition, Property: "VideoRangeType", Value, IsRequired: true }],
          },
        ],
      }),
    }).kind;
  expect(range("SDR|HDR10")).toBe("DirectPlay");
  expect(range("sdr", "Equals")).toBe("DirectPlay");
  expect(range("HDR10|DOVI")).toBe("Transcode");
  expect(range("SDR", "NotEquals")).toBe("Transcode");
  const interlaced = decidePlayback({
    ...base,
    profile: direct({
      CodecProfiles: [
        {
          Type: "Video",
          Conditions: [
            { Condition: "NotEquals", Property: "IsInterlaced", Value: "true", IsRequired: true },
          ],
        },
      ],
    }),
  });
  expect(interlaced.kind).toBe("DirectPlay");
  const capped = decidePlayback({ ...base, maxStreamingBitrate: 3_000_000 });
  expect(capped).toMatchObject({ kind: "Transcode", ceilingKbps: 3000 });
  const stricter = decidePlayback({
    ...base,
    maxStreamingBitrate: 10_000_000,
    profile: { MaxStreamingBitrate: 2_000_000 },
  });
  expect(stricter).toMatchObject({ kind: "Transcode", ceilingKbps: 2000 });
  const formats = decidePlayback({
    ...base,
    enableDirectPlay: false,
    profile: direct({
      SubtitleProfiles: [
        { Format: "ass", Method: "External" },
        { Format: "srt", Method: "External" },
      ],
    }),
  });
  expect(formats.kind === "Transcode" && [...formats.subtitles.values()]).toEqual([
    { method: "External", format: "srt" },
    { method: "Drop" },
    { method: "External", format: "ass" },
  ]);
});
