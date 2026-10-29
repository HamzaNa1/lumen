# Browser transcoding

## Decision

Use the installed FFmpeg decoder set and produce fragmented MP4 with H.264 and AAC (or WebM with VP8/Opus when that is the supported output) for incompatible browser media. Browser capability probes select direct delivery first; codec failures can retry with conversion. Preserve compatible H.264/AAC streams when repackaging a container at the beginning. Native desktop playback continues using MPV's local decoders.

Stream through bounded pipes rather than creating a full-file cache. Cancellation terminates FFmpeg, closes its output pipe, and escalates to a forced kill; the scheduler releases capacity after the process closes. Session authorization is rechecked during streaming. An inactive consumer has a bounded lease. Reject excess work instead of building an unbounded queue.

For converted playback, a seek replaces the stream. Encode video and audio after a nonzero seek: copying packets from the preceding keyframe introduces an unknown timeline offset and can break audio synchronization. This sacrifices the video-copy optimization during seeking in exchange for predictable positions. Ordinary direct playback retains file range seeking.

Offer CPU encoding, NVIDIA NVENC and Linux VAAPI with explicit device lists and least-loaded allocation. CPU decoder/filter/encoder thread limits and global/per-device admission limits bound concurrency. Hardware selection is explicit: driver or encoder failures do not silently consume CPU capacity beyond the administrator's policy. VP8 output uses software encoding, subject to an explicit software-video permission and the same global/thread limits. Hardware decoding and automatic GPU discovery are separate future decisions.

This establishes broad input codec support through FFmpeg, not a promise of every Jellyfin feature. Output is currently H.264/AAC or VP8/Opus, converted audio is stereo, and there is no adaptive bitrate ladder, subtitle burn-in, HDR tone mapping or Dolby Vision preservation. Actual input support depends on the installed FFmpeg build; GPU execution additionally depends on drivers and device access. CPU and real-browser tests cannot certify GPU hardware.

Persist transcoding policy in the server database and expose it only to administrators through Settings. Each new conversion reads the current policy, so saving requires no restart. Existing jobs retain their settings until completion; disabling conversion cancels active jobs and pending starts. Environment overrides were rejected to keep one authoritative configuration surface.

## Alternatives

- Full-file conversion caches need storage quotas, eviction and partial-file ownership while continuing work viewers no longer need.
- HLS would support adaptive bitrate output but adds playlist, segment and cache lifetime management. Fragmented streaming reuses the existing scoped media grants and transport cancellation.
- Unrestricted CPU fallback after hardware failure makes resource use unpredictable under load.
