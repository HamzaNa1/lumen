# Contributing to Lumen

Bug reports and ideas are welcome in [Issues](https://github.com/HamzaNa1/lumen/issues).

## Development

```sh
bun install
bun run dev:server    # the server on 127.0.0.1:3210, with its database in ./data
bun run dev:web       # rebuilds the web app the dev server serves at /web
bun run dev:desktop   # Electron, against your real desktop profile
bun run lint
bun run typecheck
```

The server needs FFmpeg and `ffprobe` on the path, and the desktop needs MPV. On macOS and Windows the desktop plays video through a helper process that must be built into `apps/desktop/resources/native` first: `bash apps/desktop/scripts/bundle-macos-mpv.sh` on macOS (it installs its Homebrew build dependencies), `apps/desktop/scripts/bundle-windows-mpv.ps1` on Windows.

Every test is a Playwright scenario in `tests/e2e`. Run one suite while you work with `bun scripts/test-e2e.ts source <suite>.e2e.ts --project <project>`; install the browsers once with `bunx playwright install --with-deps`. Native suites need an unlocked graphical session; Linux CI uses Xvfb with Openbox.

The desktop app and the web app are one React application (`packages/app`) with two adapters. `apps/desktop` supplies Electron IPC, saved credentials, and MPV; `apps/web` supplies the browser session, an HTML media player, and the Vite build. Shared API, playback, and watch-group logic lives in `packages/client`. The web app is a build, not a service: `bun run build:web` writes `apps/web/dist` and the server serves it under `/web`. A production server (`NODE_ENV=production`, as in the Docker image) refuses to start if the build is missing; set `LUMEN_WEB_ROOT` to serve a build from elsewhere.

A browser signs in with a host-only, `HttpOnly`, `SameSite=Strict` cookie limited to `/api`, which lasts as long as the server-side session. Every cookie-authenticated change, including sign-in and sign-out, must carry an `Origin` matching the address the app was loaded from and the app's CSRF header.
