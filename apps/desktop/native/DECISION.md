# Video helper render backends

On Windows and macOS, libmpv runs in `Lumen Video Helper`, a separate process.
It renders into GPU textures that Electron imports and draws in the page, so
video, controls and window chrome are composited together. A crash or hang in a
decoder or driver ends the helper, not the app. `helper.cpp` owns the
platform-neutral parts: options, the stdin/stdout protocol, three texture
leases, the parent watch and the shutdown watchdog. `platform_windows.cpp` and
`platform_macos.cpp` own loading libmpv, rendering and texture handoff. Linux
still embeds a standalone mpv window with `--wid`.

## Windows: Direct3D 11

Use direct D3D11 rendering from the immutable shinchiro `20261021` release,
mpv commit `e471496c56`, client API 2.6. This is a development snapshot, **not
mpv 0.41.0**. The snapshot trades stable-release maturity for a direct D3D11 render API,
avoiding an additional ANGLE interoperability layer. Keep this exact pin until Windows integration
validation justifies an update.

The downloaded, SHA-256-verified developer archive contains `client.h` with
API 2.6 and `render.h` with D3D11 parameters 21/22 and the `d3d11` backend name.
It omits `render_d3d11.h`; the vendored copy comes from the same mpv commit.
The DLL contains the backend-specific diagnostic `Texture was not created
with D3D11_BIND_RENDER_TARGET`, matching that commit's
`video/out/d3d11/libmpv_d3d11.c`. Initialization also requires successful
D3D11 render-context creation; static inspection alone is not treated as
runtime success.

This avoids ANGLE's EGL/D3D texture bridge and its DLL identity requirements.
The alternative was mpv 0.41 OpenGL through Electron's ANGLE libraries. Direct
D3D11 removes that extra context, extension negotiation, and texture wrapper.
Electron 44.4.5 still supplies the Vulkan loader (an unconditional DLL import
of the pinned libmpv) and D3D shader compiler. Both downloads are hash pinned;
all packaged files, including licenses, are covered by the native manifest.

The helper requests the default D3D11 hardware adapter, prints its LUID to
stderr, and fails on device, sharing, render, or completion errors. Electron
must import on the same adapter and surface import failure; the helper cannot
observe Electron's import operation. It does not retry with an explicit WARP
device or cross-adapter copying. Windows can still supply Microsoft Basic
Render Driver as the default adapter when no display driver is available. A D3D event query completes before publication, and the consumer's
all-references-released callback is the only valid production release point.

Driver calls and inherited pipe writes can block indefinitely on Windows.
Normal shutdown frees the render context before destroying libmpv; a separate
watchdog terminates the isolated process three seconds after shutdown begins
if either native teardown or pipe I/O does not return. This sacrifices cleanup
inside an already failing helper to bound failure recovery in the application.

After explicit cleanup, process termination also bypasses DLL-detach callbacks: Windows can otherwise deadlock detaching a DLL after stopping a thread that holds a CRT or loader lock. Pipe and parent-monitor storage remains alive until the OS reclaims the process.

Windows hosted CI uses Microsoft Basic Render Driver. Its Electron test launch
explicitly selects ANGLE D3D11 and bypasses Chromium's GPU blocklist so that
shared-texture integration can be exercised on the software driver. These flags
apply only to the CI fixture, never the packaged application. CI captures and
crash-recovery tests validate that driver path; physical-GPU performance,
Alt+Tab behavior, and adapter compatibility still require a Windows machine
with a supported GPU before release.

## macOS: OpenGL into IOSurfaces

libmpv has no Metal render API, so the helper uses the OpenGL render API on an
offscreen CGL core-profile context, the same API mpv's own `cocoa-cb` output
uses. Each of the three slots is an `IOSurface` bound as a rectangle texture
and framebuffer. A GL fence completes before publication. The stable Homebrew
mpv 0.41.0 is enough; the helper compiles against that release's headers and
loads the `libmpv.dylib` bundled beside it.

Electron imports an IOSurface only as a reference local to its own process, so
the surface has to cross processes. The helper sends each frame's surface as a
Mach port right in a Mach message to a receive port that Electron registers
with `bootstrap_check_in` under a random per-process name, and only then writes
the frame's stdout record. Electron therefore finds the message already queued
and reads it without waiting. Messages from any process other than the helper
are discarded by the sender PID in the audit trailer. Rejected alternatives:
global IOSurface IDs are deprecated and readable by any process; libmpv inside
the Electron process couples a decoder crash to the app and still needs its own
render thread; a native addon was unnecessary once koffi could drive the Mach
calls.

macOS decodes with VideoToolbox (`hwdec=videotoolbox`), and mpv falls back to
software for codecs the hardware does not decode. Decoded frames stay on the
GPU and reach OpenGL as IOSurfaces. With software decoding, uploading each frame
through Apple's OpenGL cost the helper 130% CPU for 4K60 H.264 with no consumer
attached, against 23% with VideoToolbox. Inside the app, software decoding also
dropped about 130 frames per 20 seconds, where the earlier in-process Vulkan
window dropped none.

## Both platforms

Windows deliberately forces CPU decoding. The render target is 8-bit RGBA (BGRA on
macOS) with BT.709 primaries. Preserve mpv's default SDR transfer and
reference-white handling (`target-trc=auto`, `target-peak=auto`), and carry
those display-encoded RGB values through Electron's sRGB canvas. This matches
the browser SDR presentation convention. Forcing sRGB transfer plus a 100-nit
peak instead converts ordinary SDR and invokes tone mapping against mpv's
203-nit reference white: the Windows capture test measured nominal gray 128 as
168 and gray 192 as 244. Removing only the peak override still changes the
gamma, so both overrides must remain automatic. HDR inputs retain mpv's
conversion to SDR with BT.2390 tone mapping; HDR passthrough, colorimetric HDR
accuracy and Windows hardware decoding need separate validation before enabling them.
