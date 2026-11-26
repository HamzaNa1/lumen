# Jellyfin-compatible playback API

## Decision

Lumen answers a read-only, video-only subset of the Jellyfin 12.4 API at `/jellyfin`, so viewers can use Jellyfin's native apps (Findroid, Swiftfin, Jellyfin for Android TV; Infuse best effort) with a Lumen server.

**A module that can be deleted whole.** Everything Jellyfin-specific lives in [`apps/server/src/jellyfin/`](../../apps/server/src/jellyfin/): route matching, request and response shapes, catalog queries, playback decisions, reporting and subtitle extraction. The core names Jellyfin only in comments marking what exists for Jellyfin compatibility. It gained four hooks:

1. Mounted routers in [`HttpApp.ts`](../../apps/server/src/http/HttpApp.ts) ([`MountedRouter.ts`](../../apps/server/src/http/MountedRouter.ts)). A router owns requests and labels them `media`, `login` or `api`, and the label decides the limiter, the login limit, media admission and the idle-timeout exemption. The native API is the last router, so its paths take the same route.
2. `AdaptiveStreams.serve` options: `childQuery` carries a caller's credentials into child playlists and pieces, and `ceilingKbps` drops qualities above a cap. Only the Jellyfin module sets a cap today.
3. `PlaybackService.authorizeTrack`, which authorizes media by the viewer's own library access and shares the root and path checks with `authorizeGrant`. Only the Jellyfin module calls it, and it goes with the module.
4. `AssetService.publicArtwork`, which serves an image to a caller with no account (see below). It exists only for Jellyfin apps and goes with the module.

A Biome `noRestrictedImports` rule in [`biome.json`](../../biome.json) keeps everything in `apps`, `packages` and `scripts` from importing the module, except the registration in [`Runtime.ts`](../../apps/server/src/Runtime.ts). There is no migration. Removing it means deleting the directory, the registration, `AssetService.publicArtwork` and `PlaybackService.authorizeTrack`, [`tests/e2e/jellyfin-api.e2e.ts`](../../tests/e2e/jellyfin-api.e2e.ts) with its fixtures and suite entry, the README section, and marking this record superseded. `dataDir/jellyfin/` then holds only cached subtitles and can be deleted.

**Access tokens instead of playback grants.** A Jellyfin app signs in as an ordinary Lumen device named `<Device> (Jellyfin)`, and its media URLs carry `api_key` and `PlaySessionId`. Apps keep `PlaybackInfo` URLs through long pauses and cannot renew a one-hour grant, so every media request re-authenticates the token and re-checks library access instead. Revoking the device or the account, or removing library access, takes effect on the next request. The token is read from the `MediaBrowser`/`Emby` authorization headers, `X-Emby-Token`, `X-MediaBrowser-Token` or `api_key`; never from the web app's cookie, so another site cannot borrow a browser sign-in.

**One device per app installation and account.** The device ID is a name-based UUID of the app's `DeviceId` and the username, the same shape the desktop uses. Several viewers can then share one television, and revoking one leaves the others signed in.

**Artwork answers without credentials.** Jellyfin apps load images without a token, and some (Fladder) without the image's tag, so an item's artwork is served to anyone who names the item. Item IDs are random UUIDs that only listings to viewers with access reveal, so they cannot be guessed, but anyone a viewer shares an image link with can open it. A `tag` that matches the image's content hash lets the response be cached permanently.

**Version claim.** The server reports Jellyfin `12.4.0`, the release current apps are built against. It also accepts the 10.9+ routes, the older `/Users/{userId}/…` forms, and `/Videos/ActiveEncodings`, which 12 removed but older apps still call, all matched without regard to case. Every response is checked against the 12.4.0 OpenAPI document, reduced to the routes Lumen answers.

**Playback.** [`PlaybackDecision.ts`](../../apps/server/src/jellyfin/PlaybackDecision.ts) plays the file directly when it fits the app's direct-play profiles, its codec conditions and the stricter of the request's and the profile's bitrate cap. Otherwise it offers Lumen's adaptive HLS ladder under that cap. Apps also condition direct play on the video's profile, level, bit depth and dynamic range, which the catalog does not record. [`Probe.ts`](../../apps/server/src/jellyfin/Probe.ts) reads them with ffprobe when a file is first played and keeps them for those exact bytes; the response reports the same values the decision used. Probing on play rather than at scan time needs no migration and covers files scanned before. A probe that fails leaves the values unknown, and the app's own rules for unknown values decide. Text subtitles are embedded in direct play when the profile allows, or extracted by FFmpeg into `dataDir/jellyfin/subtitles/` under a transcoding slot; picture subtitles are dropped from converted streams. Progress and track choices go to Lumen's playback sessions and track memory, so they carry over to Lumen's own apps.

## Alternatives

- **Hosting `jellyfin-web`, for Jellyfin Media Player and other wrappers.** Rejected: it would tie Lumen to Jellyfin's web client and its server behaviour, and Lumen already ships its own web app.
- **Lumen playback grants in Jellyfin URLs.** Rejected because apps hold those URLs across pauses longer than a grant lives.
- **Requiring a token for artwork.** Rejected because the target apps load images without one, so every poster would be missing.
- **Requiring the image's tag.** Tried first and dropped: Fladder sends none, and the tag protects little beyond the item ID, since any link that carries the tag carries the ID too, and a public poster's hash can be computed by anyone who has the poster.
- **A device per `DeviceId` alone.** Rejected because a second account on the same installation would be refused as a device owned by someone else.
- **Recording video profile, level, bit depth and range at scan time.** Deferred: it needs a migration and core ingest changes, and files already scanned would lack the values until a rescan. Lumen's own players could use them too, which would make it worth revisiting.
- **Letting conditions on values Lumen does not know pass.** Rejected: an app that cannot decode 10-bit video would be sent it.
- **DirectStream (copy the video, convert only the audio or container).** Deferred. Files whose audio an app cannot decode, such as DTS or TrueHD on Android TV, are fully converted at up to 1080p. It is the first follow-up and would help Lumen's web app too.
- **Jellyfin shapes in `packages/contracts`.** Rejected because no Lumen product reads them, and keeping them in the module preserves deleting it in one step.
