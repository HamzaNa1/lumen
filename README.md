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

All workspaces must have the same version. Choose the next unused SemVer, update the manifests, and push the version commit to the default branch:

```sh
bun run version:set <next-version>
bun run version:check <next-version>
```

Run the `release` workflow from the default branch with that version. It builds the desktop packages and server image, validates each package and update feed, uploads desktop assets to a draft GitHub Release, verifies the uploaded inventory, and only then publishes it. Stable publication is serialized and must advance the latest stable version. A failed run leaves its draft unpublished; rerunning the same commit can replace assets in that draft. Published versioned assets must not be overwritten.

The macOS job requires `MAC_CSC_LINK` (base64 Developer ID `.p12`), `MAC_CSC_KEY_PASSWORD`, `MAC_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. The Windows job requires `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and `WIN_PUBLISHER_NAME` matching the signing certificate. Missing credentials fail release packaging. Keep the same signing identities across updates. Linux AppImage update integrity relies on HTTPS delivery and the release feed's SHA-512 checksum, rather than native OS signing. Never put signing keys or feed tokens into the app.

The Windows release build sets `ELECTRON_BUILDER_7Z_FILTER=BCJ` and inspects the embedded NSIS archive. This avoids a [reported PE extraction failure in electron-builder 26.15.3](https://github.com/electron-userland/electron-builder/issues/9983). A clean installed A-to-B test is still required because archive inspection cannot prove the NSIS installer completes correctly.

Installed stable macOS ARM64 DMG/ZIP, Windows per-user NSIS, and Linux AppImage clients check for updates shortly after launch and about every six hours. They download a newer stable version in the background and install it during a normal application quit. Lumen stays closed; launch it again to use the new version. Settings shows download progress and readiness. Portable Windows, Linux DEB, prerelease, and development builds do not update automatically. The first updater-enabled release must be installed manually by existing clients; only a later release can exercise the automatic path.

If a check or download fails, the current client remains usable and retries later. After a crash, force kill, power loss, or interrupted installer, launch the existing app again to let it rediscover and validate the update. An abnormal exit may leave the old version in place. Keep a signed installer available for recovery; a release withdrawal cannot revoke updates already downloaded. Publish a higher fixed version to repair a bad release. Accounts, installation identity, credentials, preferences, and server media are outside the app bundle and are not cleared by updates.

Before publishing the first updater-enabled stable release, complete the packaged A-to-B upgrade matrix in [the desktop update smoke guide](tests/e2e/desktop-auto-update/README.md) on clean macOS ARM64, Windows NSIS, and Linux AppImage machines. Use a separate test feed and production-equivalent signatures. The normal `bun test` suite cannot prove installer replacement or interrupted-install recovery.

For example, after substituting your image name and media path:

```sh
docker run -d --name lumen-server --restart unless-stopped \
  -p 3210:3210 \
  -v lumen-data:/data \
  -v /path/to/media:/media:ro \
  ghcr.io/<owner>/<repository>-server
```
