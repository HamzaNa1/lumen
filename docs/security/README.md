# Security model

Network and Electron IPC inputs are treated as untrusted. The renderer is sandboxed and never receives server credentials. MPV receives a random loopback capability URL; main injects the scoped grant and forwards only the required range and conditional headers. Media sources are database-owned IDs, and roots are canonicalized before scanning.
