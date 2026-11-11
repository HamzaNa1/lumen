# Downloads and the media store

## Decision

The desktop keeps media in a media store under the loopback playback bridge (`apps/desktop/src/main/media-store`), and every direct playback reads through it. Downloads are files the store pins. Everything else it holds is streaming cache, which is off by default. Converted playback is still proxied as it arrives: a conversion has no stable bytes to keep.

**One read path.** MPV asks the bridge for byte ranges, as before. The bridge answers from the store. A reader takes whatever is held at its position: chunks on disk, chunks in memory, or bytes a running fetch has already written. When nothing is held there, it asks for a fetch at that offset and waits for it. Readers also start fetches a window ahead of themselves, sized at about two minutes of the file's average bitrate. That is what makes playback cross from downloaded parts into missing ones without a seam. Because a playing file and a downloading file use the same code, the path that makes partial downloads work is exercised by every playback.

**Storage.** Files are kept in 32 MiB segment files of 1 MiB chunks, under `<userData>/media/<server>/<source>/<revision hash>`. Writing far into a fresh sparse file on NTFS zero-fills everything before it, and one sparse file cannot give space back a part at a time. Segments avoid both. A chunk is recorded as held only once all of its bytes are written. The segment is `fdatasync`ed before the index that records the chunk is renamed into place. A crash can therefore lose records (those bytes are fetched again) but never record bytes that are not there. On open, a chunk whose segment is too short is forgotten.

**Identity.** The server names a file's exact bytes with its revision: the size-and-mtime ETag it already served, now also part of the playback start response and the download ticket. Bytes are kept per revision. Every fetch checks the response's ETag and `Content-Range`, so bytes of a changed file are never mixed with the old ones.

**Fetches.** A fetch is one open-ended range request, ending at the next held chunk. Requests stay few, well inside the media admission limits. A stream nothing is kept from writes to a small in-memory window and is paced by its readers, as the proxy was. A pinned file's fetches run to the end, so watching a download that is still in progress fills it. Background download order is the file's first 8 MiB and last 16 MiB first (where players find the index), then from the playhead onwards, then the rest.

**Grants.** Downloads use a download grant (`download_grants`), not a playback session. A grant is per device and file, lasts 30 days, and renews each time the device checks in. A lapsed grant stops its token from fetching, but a check-in renews it while the download is still allowed, so a device back after a long time away keeps its downloads. Every media request with one re-checks the user's `canDownload` permission, library access and device, so withdrawing any of these stops transfers immediately. Check-ins report each download as `valid`, `changed` or `revoked`, together with whether the viewer has watched it. The unused per-library `can_download` column is removed in favour of the per-user permission.

**Space.** The streaming cache has a fixed budget (None, 0.5, 1.5 or 5 GB). Downloads have no budget: the viewer chose them. Instead, a free-space floor (5–75% of the disk, default 10%) is checked before each new segment. Below it, the cache is emptied first. If space is still short, downloads pause and resume once there is room again with a 1% margin. Playback never stops for it: bytes the disk refuses go to memory.

**Cleanup.** Watched downloads are deleted after a delay the viewer chooses, and unopened ones optionally after 30 to 90 days. A download marked Keep is exempt from both. Space is never a reason to delete a download.

**Offline.** Each download keeps the item and its artwork as they were. When the last server cannot be reached, the app opens on the Downloads page. Playback then uses a session built from the ticket, and watch progress is held in an outbox. The outbox is replayed with `observedAtMs`, and the server applies it only over older state, so a device coming back online cannot undo newer progress made elsewhere.

**Shows.** A show rule keeps the next 1, 3 or 5 unwatched episodes downloaded. Episodes it fetched are cleaned up like any other download once watched.

**Next episode.** Once an episode counts as watched, the desktop asks the server to extend the playing session's grant to the next episode (`preload` capability). A session holds one such grant, which can never start a conversion, ends with the session and is dropped when the viewer loses the episode's library. The desktop fetches the episode's first 15 seconds (8–48 MiB) and last 4 MiB into memory outside the store. When that episode plays, the chunks become its file's memory chunks and stay until no player reads the file, so MPV's jump to the index at the end does not drop the start it comes back to.

## Alternatives

- **Downloads as a separate feature beside streaming.** This leaves the hardest part, serving a file that is partly local and partly remote, on a path that runs only when someone plays an unfinished download.
- **Reusing playback sessions to authorize downloads.** Sessions last an hour, need heartbeats, and mean "someone is watching". A download outlives the player.
- **One sparse file per media file.** See Storage above.
- **SQLite for the store's index.** Each file's chunk map is a few kilobytes. A JSON index per file with an atomic rename, plus a check of segment lengths on open, needs no new storage engine.
- **Preloading into the streaming cache.** It is off by default, and preloads would compete with what the viewer watched for its budget and write to disk for an episode that may never play. Memory holds at most one episode's start.
- **A budget for downloads.** Space a viewer asked for is not the app's to reclaim. The free-space floor protects the disk without deleting anything the viewer chose.
- **Downloading converted copies.** Rejected for the same reasons as full-file conversion caches (see the transcoding ADR). Files MPV cannot decode do not play offline.
- **Browser downloads.** A Service Worker and OPFS could reuse the same chunk map and cleanup rules from `@lumen/client`. That is deferred; the web app reports downloads as unavailable.
