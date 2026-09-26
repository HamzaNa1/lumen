# Windows playback regression

Lumen 0.0.3 embedded MPV's native child window in an Electron `BaseWindow`.
On Windows, that host's Chromium compositor covered the video. MPV could load,
decode, and advance a video normally while the app showed a black surface.

The [baseline Windows run](https://github.com/HamzaNa1/lumen/actions/runs/36212633948)
reproduced this with the same MPV 0.41.0 binary bundled in releases. MPV's own
screenshot was red, but the desktop screenshot was black. Removing the controls
overlay, raising the host, and explicitly showing its already-visible children
did not expose the video.

`WindowsMpvHost` now supplies a plain Win32 window owned by the main app window.
MPV renders into it without a second Chromium compositor. The existing Electron
overlay still draws the controls. Bounds are converted from Electron's logical
coordinates into physical screen pixels to support display scaling.

There was also a stop/replay race: `MpvProcess.stop()` completed immediately after
sending the termination signal. A replacement player could start while the old
process still held its video window and audio output. Stop now waits for process
exit, including overlapping stop calls, and handles executable startup errors.
This removes a potential source of intermittent playback; it does not establish
the cause of every hardware-specific audio failure.

## Verification

- `bun run check`: lint, all workspace typechecks, Bun tests, and builds.
- `.github/workflows/windows-playback.yml`: real Electron and bundled MPV on a
  Windows runner, using the production surface, controller, IPC, and HTTP bridge.
- The native test checks desktop pixels as well as playback state, repeated
  start/stop, pause/seek/resume, mute/volume, resizing, minimize/restore, fullscreen,
  and 100%/150% scaling. Decoded-frame screenshots and MPV logs are retained in
  the `windows-playback-evidence` artifact.
- Hosted runners have no audio playback device. The test uses MPV's PCM output
  and checks for non-silent decoded audio. Actual WASAPI output through speakers
  or headphones must still be checked on a Windows PC.

The workflow builds the normal x64 portable executable and installer only after
the native test passes. Download the `lumen-windows-test` artifact, close an
existing Lumen instance, and run the portable executable. Test the videos that
failed before, including seeking, pausing, going Back, and immediately playing
another video. Also check fullscreen and sound through the usual output device.

The synthetic test fixture contains a red H.264 frame and a 440 Hz AAC tone. It
was generated without third-party media:

```sh
ffmpeg -f lavfi -i color=c=red:s=640x360:r=24 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 20 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k \
  -movflags +faststart tests/fixtures/playback.mp4
```
