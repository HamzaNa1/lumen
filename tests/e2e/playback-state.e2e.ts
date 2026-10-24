import { expect, password, test } from "./support/server";

test("progress sequencing and manual watch state survive restart and reject stale and foreign sessions", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4"]);
  const item = (await server.items(token, library.id))[0];
  expect(item).toBeDefined();
  const playback = await server.play(token, item?.id ?? "");
  const path = `/playback/sessions/${playback.sessionId}`;
  const progress = (sequence: number, positionMs: number, session = path) =>
    server.api(`${session}/progress`, {
      token,
      status: 200,
      body: { trackId: item?.id, positionMs, durationMs: 20000, sequence },
    });
  const watchState = () => server.api(`/items/${item?.id}`, { token });
  await server.api(`${path}/heartbeat`, {
    token,
    status: 200,
    body: { state: "paused", activeTrackId: item?.id, errorCode: null },
  });
  await progress(2, 7000);
  await progress(1, 2000);
  expect(await watchState()).toMatchObject({
    watchState: { positionSeconds: 7, completed: false },
  });
  await server.api(`/items/${item?.id}/watch-state`, {
    token,
    method: "PUT",
    body: { positionSeconds: 0, completed: true },
  });
  await server.restart();
  await progress(3, 8000);
  expect(await watchState()).toMatchObject({ watchState: { positionSeconds: 0, completed: true } });
  const replacement = await server.play(token, item?.id ?? "");
  await progress(1, 5000, `/playback/sessions/${replacement.sessionId}`);
  await progress(4, 9000);
  expect(await watchState()).toMatchObject({
    watchState: { positionSeconds: 5, completed: false },
  });
  await server.api("/users", {
    token,
    body: { username: "other", displayName: "Other", password, libraryAccess: { scope: "all" } },
  });
  const other = await server.login("other");
  await server.api(`${path}/heartbeat`, {
    token: other.accessToken,
    status: 403,
    body: { state: "playing", activeTrackId: item?.id, errorCode: null },
  });
  await server.api(path, { token, method: "DELETE" });
  await server.api(`${path}/heartbeat`, {
    token,
    status: 409,
    body: { state: "playing", activeTrackId: item?.id, errorCode: null },
  });
});

test("track preferences and per-title choices persist across devices and reject foreign streams", async ({
  server,
  admin,
}) => {
  const token = admin.accessToken;
  const library = await server.library(token, "movies", ["Film.mp4", "Other.mp4"]);
  const [film, other] = await server.items(token, library.id);
  expect(await server.api("/me/track-preferences", { token })).toEqual({
    audioLanguage: "en",
    subtitleLanguage: null,
  });
  await server.api("/me/track-preferences", {
    token,
    method: "PATCH",
    body: { subtitleLanguage: "fr" },
  });
  expect(await server.api("/me/track-preferences", { token })).toEqual({
    audioLanguage: "en",
    subtitleLanguage: "fr",
  });
  const playback = await server.play(token, film?.id ?? "");
  const second = await server.play(token, other?.id ?? "");
  const audio = playback.streams.find((stream) => stream.kind === "audio");
  const foreign = second.streams.find((stream) => stream.kind === "audio");
  expect(audio).toBeDefined();
  const choice = `/playback/sessions/${playback.sessionId}/track-choice`;
  await server.api(choice, { token, method: "PUT", body: { kind: "audio", choice: audio?.id } });
  await server.api(choice, { token, method: "PUT", body: { kind: "subtitle", choice: "off" } });
  await server.api(choice, {
    token,
    method: "PUT",
    status: 400,
    body: { kind: "audio", choice: foreign?.id },
  });
  const device = await server.login();
  expect(await server.play(device.accessToken, film?.id ?? "")).toMatchObject({
    trackMemory: {
      preferences: { audioLanguage: "en", subtitleLanguage: "fr" },
      audio: { streamId: audio?.id },
      subtitle: "off",
    },
  });
  await server.api(choice, {
    token: device.accessToken,
    method: "PUT",
    status: 403,
    body: { kind: "audio", choice: null },
  });
  await server.restart();
  const revisited = await server.play(token, film?.id ?? "");
  expect(revisited).toMatchObject({
    trackMemory: { audio: { streamId: audio?.id }, subtitle: "off" },
  });
  const reset = `/playback/sessions/${revisited.sessionId}/track-choice`;
  expect(
    await server.api(reset, { token, method: "PUT", body: { kind: "audio", choice: null } }),
  ).toMatchObject({ audio: null, subtitle: "off" });
  expect(
    await server.api(reset, { token, method: "PUT", body: { kind: "subtitle", choice: null } }),
  ).toMatchObject({ audio: null, subtitle: null });
  await server.api("/me/track-preferences", {
    token,
    method: "PATCH",
    status: 400,
    body: { audioLanguage: "not a language" },
  });
});
