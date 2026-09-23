# Lumen

Lumen is a Bun-based direct-play media server with an Electron desktop client. It stores original media on the server filesystem, scans multiple library roots, authorizes accounts independently per server, and streams original bytes to a packaged MPV player over a session-scoped loopback bridge.

## Development

```sh
bun install
bun run typecheck
bun run lint
bun test
bun run dev:server
bun run dev:desktop
```

Create the first administrator with:

```sh
bun run create-admin -- --username admin --display-name "Administrator" --password "a long local password"
```

The server requires no transcoder. Configure a read-only media root and a local SQLite data directory before scanning.
