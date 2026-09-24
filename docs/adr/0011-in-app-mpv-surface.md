# In-app MPV surface

Supersedes the dedicated-window presentation in ADR 0008.

Playback remains owned by Electron main, but MPV is presented inside a dedicated renderer route instead of as a separately decorated player. On Win32 and X11, Electron creates a child native host window and MPV attaches to it with `--wid`. macOS uses a borderless, Dock-hidden MPV window that Electron keeps aligned with the route's reported surface because the standalone MPV process cannot attach to a foreign `NSView`.

The renderer may report only integer surface bounds and invoke named playback operations. Credentials, capability URLs, arbitrary MPV commands, and native handles stay in Electron main.
