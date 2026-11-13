# Lumen

Lumen is a Bun-based direct-play media server with an Electron desktop client and a web app the server hosts at `/web`. It stores original media on the server filesystem, scans multiple library roots, authorizes accounts independently per server, and streams original bytes to an in-app MPV player over a session-scoped loopback bridge.

## Development

```sh
bun install
bun run typecheck
bun run lint
bun run test:e2e
bun run dev:server
bun run dev:desktop
bun run dev:web
```

The E2E suite requires FFmpeg, MPV, Electron and the Playwright browsers (`bunx playwright install --with-deps`). On macOS and Windows the desktop plays video through a helper process that must be built into `apps/desktop/resources/native` first: `brew install mpv dylibbundler && bash apps/desktop/scripts/bundle-macos-mpv.sh` on macOS, `apps/desktop/scripts/bundle-windows-mpv.ps1` on Windows. Run `bun run check` for formatting, types, builds and instrumented E2E coverage. Native checks need an unlocked graphical session; Linux CI uses Xvfb with Openbox.

## Web app

The desktop app and the web app are one React application (`packages/app`) with two adapters. `apps/desktop` supplies Electron IPC, saved credentials and MPV; `apps/web` supplies the browser session, an HTML media player and the Vite build. Shared API, playback-session and watch-group logic lives in `packages/client`.

The web app is a build, not a service: `bun run build:web` writes `apps/web/dist`, and the server serves it under `/web`. `bun run dev:web` rebuilds on every change while `bun run dev:server` serves the result, so development uses the same routing, cookies and content security policy as production. A production server (`NODE_ENV=production`, as in the Docker image) refuses to start if the build is missing; set `LUMEN_WEB_ROOT` to serve a build from elsewhere.

The browser plays files directly, so it can only play what the browser itself decodes. Files it cannot play say so; the desktop app plays everything MPV does.

A browser signs in with a session cookie rather than a token it could read:

- The cookie is host-only, `HttpOnly`, `SameSite=Strict`, limited to `/api`, and lasts as long as the server-side session, which is extended while it is in use.
- `LUMEN_COOKIE_SECURE` is `auto` by default: the cookie is `Secure` when the app is reached over HTTPS (directly, or as reported by a proxy's `X-Forwarded-Proto`) and not over the plain HTTP of local development or a home network, where a `Secure` cookie would never be sent back. Set `always` to refuse plain HTTP sign-ins, or `never` to override a proxy that misreports the scheme.
- Every cookie-authenticated change, including sign-in and sign-out, must carry an `Origin` matching the address the app was loaded from and the app's CSRF header. If a reverse proxy rewrites `Host` without setting `X-Forwarded-Host`, list the public address in `LUMEN_ALLOWED_ORIGINS` (comma-separated origins).

`bun run test:browser` builds the web app and runs the browser tests in Chromium, Firefox and WebKit against a real server (install the browsers once with `bunx playwright install`). `bun scripts/smoke-server-image.ts <image>` checks that a server image serves its web app.

On first launch, open the desktop app, enter the server address, and create the first account. That account becomes the server administrator; subsequent users are managed from Administration.

The server requires no transcoder. Configure a read-only media root and a local SQLite data directory before scanning.

## Releases

Server and desktop releases are independent within the monorepo. The web app has no version or release of its own: it is built into the server image and reports the server's version. Each app's `package.json` owns its release version; private shared packages are built from the release commit and do not share either app's release numbering. GitHub tags start with the version and identify the product using build metadata (`v0.0.10+server` or `v0.0.10+desktop`), so GitHub can recognize the version for sorting without treating the product name as a prerelease identifier. Existing combined `v0.0.x` tags and earlier `server-v...` / `desktop-v...` tags remain valid release history and compatibility baselines. Product versions can diverge, so the repository-wide release list is not a chronological feed for either product.

Prepare only the app being released, then push its version commit to the default branch:

```sh
bun run version:set server 0.0.8
bun run version:check server 0.0.8
# Or release the desktop independently:
bun run version:set desktop 0.0.8
bun run version:check desktop 0.0.8
```

`version:set` commits only that app's manifest and `bun.lock`. Package manifests, the lockfile, and `bunfig.toml` must be clean first so unrelated dependency changes cannot enter the release commit. Server and desktop versions can diverge; neither command bumps the other app or shared packages.

Run `release-server` or `release-desktop` in GitHub Actions from the default branch with the prepared version. Release eligibility is product-specific: `bun run check:server` or `bun run check:desktop` validates the selected app, its shared dependencies, and release tooling. Each release also tests against the latest stable counterpart (using a historical combined tag until that product has a separate release). This allows a healthy product to ship while the other app's development version is broken, while shared contract or released-counterpart compatibility failures still block affected releases. Full-repository `bun run check` remains the development and CI gate. Tags and release titles identify the product: `v0.0.10+server` / `Lumen Server v0.0.10`, or `v0.0.10+desktop` / `Lumen Desktop v0.0.10`.

Server releases publish AMD64 and ARM64 images as `ghcr.io/<owner>/<repository>-server:<version>` and `:sha-<commit-sha>`, with the exact digest in their release notes. Stable images update `:latest` after the GitHub Release succeeds. Each server release also attaches a Linux service package per architecture (`lumen-server-<version>-linux-<arch>.tar.gz`, the image's application tree with its Bun) and their `SHA256SUMS`. Desktop releases own GitHub's Latest designation, so a stable server release instead uploads its version and `install.sh` to the fixed `server-latest` release, which the installer and automatic updates read. Desktop releases attach the installers and own GitHub's repository-wide Latest designation. The installed Windows app updates itself from that Latest release: it downloads the installer named by the release's `latest.yml`, in the background unless the viewer turns automatic updates off in Settings, then installs it when the viewer chooses to restart, on the next quit, or on the next launch. Windows builds are not code-signed, so an update is trusted on the strength of the release itself: HTTPS and the SHA-512 in `latest.yml`. macOS, Linux and the portable Windows build check the same Latest release and offer a button that opens its page, where the viewer downloads the new version. macOS builds are signed with a self-signed certificate and not notarized, so the first launch needs Open Anyway under System Settings → Privacy & Security. `release-desktop` loads that certificate from the `MACOS_SIGNING_CERTIFICATE` (a base64 `.p12`) and `MACOS_SIGNING_CERTIFICATE_PASSWORD` secrets and fails unless the app carries the fingerprint pinned in `apps/desktop/scripts/sign-macos.mjs`. Never replace the certificate: macOS ties Keychain access and privacy permissions to it, so a new one makes every installed copy ask for them again. A version such as `0.0.9-rc.1` creates a prerelease and never updates either stable Latest designation. GHCR controls image visibility.

Publication is serialized per app, and versions must advance within that app's release history so older runs cannot move Latest backward. Release notes include that app and its shared dependencies since its previous release, with deduplicated PR links, author attribution, and a full repository comparison. Commits without a merged PR retain their commit link and author instead of disappearing from the notes. GitHub lookup failures block publication rather than silently omitting attribution. Failed server image promotion can be retried by rerunning the failed `promote` job; a newer stable release blocks promotion of an older image.

Application versions do not determine client/server compatibility. The handshake advertises an independent API version and optional capabilities; the desktop accepts stable API `1.x` and rejects incompatible versions before sign-in. Additive features should use capabilities, while breaking protocol changes require a new API major version. The release compatibility test covers discovery, authentication, session restoration, and library browsing against the latest stable counterpart. Run it locally after fetching tags with `bun scripts/check-release-compatibility.ts server` or `desktop`.

For example, after substituting your image name and media path:

```sh
docker run -d --name lumen-server --restart unless-stopped \
  -p 3210:3210 \
  -v lumen-data:/data \
  -v /path/to/media:/media:ro \
  ghcr.io/<owner>/<repository>-server
```

### Linux service

On a systemd Linux distribution with glibc, on AMD64 or ARM64, the server can run as a service instead of a container:

```sh
curl -fsSL https://github.com/HamzaNa1/lumen/releases/download/server-latest/install.sh | sudo sh
# Pass options after `sh -s --`: --auto-update, or --version=X.Y.Z for a specific release.
```

The installer installs FFmpeg with the system package manager when it is missing, then installs the release under `/opt/lumen` and starts `lumen.service` as the `lumen` system user. Settings are in `/etc/lumen/lumen.env` and the database in `/var/lib/lumen`; both survive updates and uninstalls. The service can write only to `/var/lib/lumen`, so give the `lumen` user read access to each library root.

```sh
sudo lumenctl status               # version, available update, service and FFmpeg state
sudo lumenctl update               # install the latest stable release now
sudo lumenctl auto-update on       # or off: a daily check between 04:00 and 05:00
sudo lumenctl uninstall [--purge]  # --purge also deletes settings, data and the user
```

Updates only move forward and replace the running version; there is no automatic rollback. A download that fails its checksum leaves the installed version running. Running the installer again repairs an installation.
