# Windows render backend decision

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

CPU decoding is deliberately forced for this initial implementation. The previous
standalone mpv launch used no config and did not set hwdec, whose default was
also no; the new helper makes that choice explicit. The packaged player moves
from the previous release pin to the development snapshot above. The
render target is RGBA8 UNORM with BT.709 primaries. Preserve mpv's default SDR
transfer and reference-white handling (`target-trc=auto`, `target-peak=auto`),
and carry those display-encoded RGB values through Electron's sRGB canvas.
This matches the previous player and browser SDR presentation convention.
Forcing sRGB transfer plus a 100-nit peak instead converts ordinary SDR and
invokes tone mapping against mpv's 203-nit reference white: the Windows capture
test measured nominal gray 128 as 168 and gray 192 as 244. Removing only the
peak override still changes the gamma, so both overrides must remain automatic.
HDR inputs retain mpv's conversion to SDR with BT.2390 tone mapping; HDR
passthrough, colorimetric HDR accuracy and hardware decoding need separate
validation before enabling them.

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
