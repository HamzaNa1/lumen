# In-app MPV surface

Supersedes the dedicated-window presentation in ADR 0008.

Playback remains owned by Electron main, but MPV is presented inside a dedicated renderer route instead of as a separately decorated player. Electron creates a child native host window and MPV attaches to it with `--wid`. Windows and Linux use the packaged MPV process; Linux runs Electron through X11/XWayland so both processes share an X11 window ID. macOS loads packaged libmpv in the Electron main process, allowing MPV to attach to Electron's `NSView` without creating another application window.

The renderer may report only integer surface bounds and invoke named playback operations. Credentials, capability URLs, arbitrary MPV commands, and native handles stay in Electron main.
