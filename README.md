# Lumen

Lumen is a Bun-based direct-play media server with an Electron desktop client. It stores original media on the server filesystem, scans multiple library roots, authorizes accounts independently per server, and streams original bytes to an in-app MPV player over a session-scoped loopback bridge.

## Development

```sh
bun install
bun run typecheck
bun run lint
bun test
bun run dev:server
bun run dev:desktop
```

On first launch, open the desktop app, enter the server address, and create the first account. That account becomes the server administrator; subsequent users are managed from Administration.

The server requires no transcoder. Configure a read-only media root and a local SQLite data directory before scanning.

## Releases

All workspaces currently use `0.0.1` for the first release. Check it, then commit and push these changes to the default branch:

```sh
bun run version:check 0.0.1
```

In GitHub Actions, run the `release` workflow from the default branch and enter `0.0.1` as the version. The workflow requires that version to match every workspace and rejects an existing `v0.0.1` tag. After the desktop installers and server image succeed, it creates a GitHub Release and tag named `v0.0.1`, attaches the installers, and publishes a multi-platform server image for AMD64 and ARM64 as `ghcr.io/<owner>/<repository>-server:0.0.1` and `:sha-<commit-sha>`. Stable releases also update `:latest`; prereleases do not. GitHub Container Registry controls whether the image is public or private.

For later releases, run `bun run version:set 0.0.2`. The command updates the manifests and `bun.lock`, then creates a `chore: release 0.0.2` commit containing only those files. Push the commit to the default branch and enter `0.0.2` in the workflow. A version such as `0.0.2-rc.1` creates a prerelease.

For example, after substituting your image name and media path:

```sh
docker run -d --name lumen-server --restart unless-stopped \
  -p 3210:3210 \
  -v lumen-data:/data \
  -v /path/to/media:/media:ro \
  ghcr.io/<owner>/<repository>-server
```
