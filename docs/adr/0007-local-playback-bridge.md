# Local playback bridge

Electron main owns credentials, MPV lifecycle, and a session-scoped loopback bridge. MPV receives a random capability URL, while the bridge adds the scoped playback grant and forwards only media requests. The bridge is not a generic proxy.
