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

## Closing the player window

The follow-up `Object has been destroyed` exception came from a deferred focus
callback in `MpvSurface`. A blur event queued a timer, closing the app destroyed
the parent/overlay windows, and the timer then called `isFocused()` on a destroyed
Electron object. Stopping media first did not remove these listeners, so closing
the app after Back could still trigger the same exception.

Surface disposal now cancels pending focus work, removes its event listeners,
and guards callbacks against either window being destroyed. Overlay operations
also tolerate the child already being destroyed by its parent. Two regression
tests reproduced the original exception before the fix. The native Windows test
closes the actual windows after stopping media, during playback, and while paused;
it drains queued callbacks and checks for asynchronous exceptions, remaining
native windows, and surviving MPV processes before quitting normally.

The workflow builds the normal x64 portable executable and installer only after
the native test passes. Download the `lumen-windows-portable` artifact, close an
existing Lumen instance, and run the portable executable. Test the videos that
failed before, including seeking, pausing, going Back, and immediately playing
another video. Also check fullscreen and sound through the usual output device.

## Surround audio on Windows

A follow-up report isolated silent House episodes (DTS 5.1 and AC-3 5.1) from
working Re:Zero episodes (AAC or E-AC-3 stereo), using a USB wireless-headset
dongle. Read-only probes of the original media confirmed those layouts, and a
short decode of a House episode produced non-silent samples. The
[Windows codec baseline](https://github.com/HamzaNa1/lumen/actions/runs/36228389021)
also decoded synthetic DTS, AC-3, and E-AC-3 through the production playback path.
Missing codec support and incorrect audio-track mapping were not reproduced.

Windows now defaults to an explicit stereo downmix before audio output. This
avoids depending on a headset driver's advertised surround layout to route the
center/dialogue channel. Playback settings offer Automatic (system layout) for
surround systems; the selection lasts until the app closes. Other platforms keep
their previous automatic default. MPV documents these options in its
[audio-channels reference](https://mpv.io/manual/stable/#options-audio-channels).

The device-layout explanation remains a hypothesis until the affected headset
is retested. The runner has no WASAPI device. Copy audio diagnostics in playback
settings captures the selected MPV track, codec, input/output channel layouts,
device list, mute, volume, and software versions. It excludes stream URLs, media
paths, library metadata, and authentication tokens.

Native tests now verify that center-only DTS/AC-3 tones reach **both** stereo
channels, E-AC-3 stereo remains audible, output switching works while paused,
and the overlay can copy diagnostics through its preload bridge. Portable and
installer executables are uploaded separately to avoid doubling the download.

The additional MKV fixtures reuse the red video and contain generated tones.
For DTS/AC-3 the lavfi source is
`aevalsrc=0|0|0.25*sin(2*PI*440*t)|0|0|0:s=48000:c=5.1(side):d=20`,
encoded with `-c:a dca -strict -2 -b:a 768k` or `-c:a ac3 -b:a 384k`.
E-AC-3 uses
`aevalsrc=0.25*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):s=48000:c=stereo:d=20`
and `-c:a eac3 -b:a 192k`. All use `-map 1:v -map 0:a -c:v copy -shortest`
with the generated audio as input 0 and `playback.mp4` as input 1.

The synthetic test fixture contains a red H.264 frame and a 440 Hz AAC tone. It
was generated without third-party media:

```sh
ffmpeg -f lavfi -i color=c=red:s=640x360:r=24 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 20 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k \
  -movflags +faststart tests/fixtures/playback.mp4
```
