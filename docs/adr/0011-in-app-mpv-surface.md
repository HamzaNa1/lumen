# In-app MPV surface

Supersedes the dedicated-window presentation in ADR 0008.

Playback remains owned by Electron main, but MPV is presented inside a dedicated renderer route instead of as a separately decorated player. Electron creates a child native host window. Windows and Linux attach the packaged MPV process with `--wid`; Linux runs Electron through X11/XWayland so both processes share an X11 window ID. macOS loads packaged libmpv in the Electron main process and attaches its video window as an owned native child of the host window. This is still a composition of native windows, not rendering directly into the app's view.

On macOS, the video window keeps MPV's default Cocoa style. MPV's `--border=no` hides its title bar but retains rounded window corners. Changing its style mask at runtime caused Electron crashes, so the corners remain until a safer presentation path is available. The transparent controls window has square corners. When controls receive keyboard focus, the app remains Cocoa's main window so its title bar stays active; the controls retain key-window status for keyboard navigation and track selection. Geometry updates do not reorder the video window; showing the surface restores the video and controls in order. On stop, the host is hidden and the video window is detached once before libmpv is destroyed; the app does not send Cocoa commands to the video window during teardown. Libmpv destruction runs on a worker thread so its video output can dispatch Cocoa cleanup to Electron's main thread.

The renderer may report only integer surface bounds and invoke named playback operations. Credentials, capability URLs, arbitrary MPV commands, and native handles stay in Electron main.
