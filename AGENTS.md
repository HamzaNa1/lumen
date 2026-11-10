# Lumen

Lumen is a self-hosted media server. A Bun server scans library roots on its filesystem into a SQLite catalog and serves media to an Electron desktop app, which plays it in MPV, and to a web app the server hosts at `/web`.

You can think of Lumen as a self-hosted alternative to Jellyfin and Plex.

## What makes Lumen special?

These are the things we can never compromise on.

### 1. Reliable under failure

Reliability comes first. Lumen runs unattended on home servers with unplugged drives, flaky networks, and laptops that sleep mid-download. Behavior stays predictable under load and during failures: an unavailable root keeps its catalog, a crash can lose work but never record bytes that are not there, and excess work is rejected instead of queued without bound. Library roots are read-only to Lumen: it never writes, renames, or deletes under one. If a tradeoff is required, choose correctness and robustness over short-term convenience.

### 2. The UI feels instant

Input shows its result in the frame it happens. Render what is already known (cached data, optimistic state) and reconcile when the server answers. Do not block navigation, seeking, or scrubbing on a request. No spinner for work that takes a moment, no layout that jumps when data arrives, no list that stutters while it scrolls.

### 3. Released versions keep working together

The server and the desktop release independently, and people update them at different times. A new desktop must work with an older server, an older desktop with a new server, and a new server must open any database a released server wrote. The web app ships inside the server image, so it always matches its server.

## How to approach the work

We like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the developer's intent in both a minimal and realistic fashion.

Lumen is in early development. Breaking and large internal changes are welcome when they leave a cleaner, more maintainable codebase. What may not break is what has shipped: the contract with a released counterpart and the data a released version stored (see 3 above).

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: you are usually working on the same machine where the developer runs their own Lumen app and server, and often several worktrees at once. Be careful about processes, ports, and data that are not yours.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Lumen.
- **we, us, and the developer** mean the people building Lumen. These are who you are talking to now.
- **viewer** means a person signed in to a server to watch or listen. An **administrator** is a viewer who also manages that server.
- **server** means one running Lumen server with its own database, accounts, and libraries. Accounts belong to one server.
- **client** means the desktop app or the web app. Both are the same React app with a different **adapter**.
- **adapter** means what a client supplies to the shared app: its session, saved credentials, and player.
- **product** means something we release: `server` or `desktop`. The **released counterpart** is the latest stable release of the other product.
- **library** means a named collection built from one or more roots. A **root** is a directory on the server's filesystem.
- **source** means one media file under a root. An **item** is the catalog entry a viewer browses, such as a movie, show, episode, or track.
- **scan** means discovery a viewer asked for. A **check** is the scheduled comparison the watcher runs on its own.
- **revision** has two meanings, so say which. A **library revision** is the counter that fences a reconciliation plan. A **file revision** names a file's exact bytes by size and modification time.
- **playback session** means the server's record that a viewer is watching an item right now. It is short-lived and kept alive by heartbeats.
- **grant** means a token scoped to media a viewer may fetch. A **download grant** belongs to one device and file and outlives any playback session.
- **bridge** means the desktop's loopback endpoint that MPV reads from. It answers from the **media store**, which holds downloads and streaming cache.
- **conversion** means the server transcoding a file with FFmpeg for a client that cannot decode it.
- **watch group** means viewers watching the same item in sync over the server's WebSocket.

## The three ways to do damage

1. **Killing by pattern.** Never `pkill`, `killall`, `pgrep | kill`, or `kill` a PID you found by matching a name or path. `bun`, `electron`, `mpv`, and `ffmpeg` also match the developer's own Lumen app, the coding app you are running in, and other worktrees' servers and tests. Kill only a PID you captured at spawn, or the owner of your port from `lsof -nP -iTCP:<port> -sTCP:LISTEN` after confirming with `lsof -a -p <pid> -d cwd` that it runs from your worktree.
2. **Touching the real install.** The desktop profile (`~/Library/Application Support/lumen-desktop` on macOS, the matching `userData` directory elsewhere) holds the developer's saved servers, tokens, and downloads, and `bun run dev:desktop` opens that same profile. Reading it is fine. Never clean it, never write to it from a script, and do not start `dev:desktop` unless the task needs the real app. The same goes for real media: never point a dev server or a test at the developer's library, and never write under any root. Tests build their own fixtures in temporary directories.
3. **Rewriting what has shipped.** A migration in `packages/database/drizzle` that is on `main` is immutable. Editing one breaks the upgrade for every existing database. Add a new migration instead (`bun run db:generate`, or handwritten when it needs a backfill) and an upgrade case in `tests/e2e/database-upgrade.e2e.ts`. The same applies to the wire: do not change the meaning of a field a released client or server already reads.

## Hit every surface

The most common defect in a repo like this is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Clients.** Desktop and web are one app (`packages/app`) with two adapters. A feature needs a decision per adapter, even if the decision is "unavailable here", as downloads are on the web. Logic both need lives in `packages/client`, not in two copies.
- **Players.** MPV on the desktop and the browser's media element on the web, each with direct and converted playback. Seeking, track selection, resume, and pause behave differently in all four.
- **Contracts.** Anything crossing HTTP, the WebSocket, or Electron IPC is typed in `packages/contracts`. Change the schema there and let the server, clients, and tests follow.
- **Versions.** Ask what happens with an older server and with an older desktop. New server behavior is advertised through a capability flag so clients do not call what is not there, and responses a client only reads tolerate values from other versions.
- **Stored data.** A schema change needs a migration and an upgrade case. Desktop state on disk (connections, the media store index, downloads) written by an older version must still open.
- **Permissions.** Administrator and viewer, library access, and per-user permissions such as `canDownload`. The server is authoritative and re-checks on every request. Hiding a control is not authorization.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Download needs delete. Join needs leave. Disable needs enable. A one-way door is a bug.
- **Failure states.** Server unreachable, root unmounted, session expired, disk full, file changed underneath a download. Decide what the viewer sees in each.
- **Platforms.** The desktop ships on macOS, Windows, and Linux; the web app runs in Chromium, Firefox, and WebKit. You can run one operating system locally, so say which one you did.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `bun install` installs. A fresh worktree has no `node_modules`; if module resolution looks broken, it probably did not run.
- `bun run dev:server` starts the server on `127.0.0.1:3210`. Its database lives in the checkout's gitignored `data/`, so each worktree gets its own. The port is fixed, so set `LUMEN_PORT` when another worktree already holds it. `.env.example` lists the settings.
- `bun run dev:web` is a watching build, not a server. It rewrites `apps/web/dist` on every change and the dev server serves the result at `/web`, with the same routing, cookies, and content security policy as production. There is no proxy and no origin to configure.
- `bun run dev:desktop` starts Electron against the real desktop profile. See rule 2.
- The server needs `ffprobe` and FFmpeg on the path; the desktop needs MPV.
- Stop what you started, by the PID you tracked. See rule 1.

## Verifying

- Every test is a Playwright scenario in `tests/e2e` that runs at a real boundary: server processes with their own SQLite files, real browsers, Electron, and MPV. There is no unit runner and production services are not mocked. Pure logic is tested in the same runner without I/O, as `library-diff.e2e.ts` does.
- While you iterate, run the suite that owns the behavior: `bun scripts/test-e2e.ts source <suite>.e2e.ts --project <project> -g "<name>"`. Projects are `api`, `tooling`, `chromium`, `firefox`, `webkit`, and `native`.
  - The runner builds the web and desktop apps first. Add `--no-build` when client code has not changed since the last build. Server-backed suites still need `apps/web/dist` to exist; `bun run build:web` creates it in seconds.
  - Add `--no-deps` with `--project native`, or Playwright runs every other project before it.
  - Native suites open real Electron windows and need an unlocked graphical session. Run the suite you need, not the whole project.
- Before you push, run `bun run lint` and `bun run typecheck` (seconds each), plus the suites that own what you changed, in each project they belong to. One browser is enough locally.
- **Do not run the full suite.** No `bun run check`, `bun run test`, `bun run test:coverage`, `check:server`, or `check:desktop` unless I ask. CI owns three browsers, native runs on three operating systems, coverage, release compatibility, and packaging.
- CI fails when a workspace's uncovered lines exceed its budget in `coverage-baseline.json`. New production code has to be executed by a scenario. Never raise a budget without the developer's sign-off.
- A new suite file must be registered in `scripts/lib/verification.ts` with its runtime and products, or the runner refuses to start.
- Test behavior that can break, such as scanning and reconciliation, auth and permission checks, migrations, media delivery and range handling, playback state, races, version compatibility, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, and static markup.
- Extend before you add. When an existing scenario or table covers the behavior, add a row or an assertion there. Write a new `test` only when no case fits.
- Test at one layer: the lowest project that fails on `main`. Prefer `api` over a browser and a browser over `native`. Do not repeat the case at each layer above it.
- Never wait on time. Wait for an observable condition or an event. No sleeps, no `waitForTimeout`, no timer delays; `tooling/biome/no-test-delays.grit` fails lint on them. No retries, no raised timeouts, and no skips to turn a failure into a pass. A flaky test is a bug in the test or the product, and it gets fixed.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing scenario first, then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- User-visible changes get one pass in a real client before you call them done. Use Playwright to take the screenshots or video.
- A performance claim needs a measurement from before and after. `apps/server/scripts/benchmark-scan.ts` is the scan harness; `benchmarks/` holds the others.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix: keep job logs readable across server versions`.
- Body: the problem in a sentence or two, then how you fixed it, then the proof. End with the model and harness that did the work.
- Always include proof. Use the proof the request names. When it names none, include what a reviewer needs to believe the change: before/after images for UI, a short video for motion or timing, test output or measurements for the rest.
- Upload evidence with `gh pr create --attach <file>`. Never commit PR-only screenshots, charts, or raw measurements. A benchmark harness is code and belongs in the repo; its output belongs in the PR.
- One request is one PR. Split it only when the developer asks.
- Do not bump a version or start a release unless asked. The release flow is in the README.

## Documentation

Most code changes do not need a documentation change. Code must be self-explanatory, and agents can read it.

- `docs/adr/` is for decisions and the alternatives that were considered: why this design, what was rejected and why, and constraints that span components. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, or append PR summaries. Types, tests, and code already record the implementation.
- A local reason the code can't show goes in a short nearby code comment. Use an ADR when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new ADR needs a distinct, durable decision to record.
- `README.md` is for people running and releasing Lumen. Update it when setup, configuration, or the release flow changes. A UI tweak does not need an entry.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree.
- A merged PR is the implementation record. Do not preserve a second checklist or a proof log in the repository.

## How it works

The server scans each library's roots into a SQLite catalog and serves an HTTP API, the built web app, and the watch-group WebSocket. A client signs in to one server, with a token on the desktop and an `HttpOnly` session cookie in the browser, then browses the catalog and starts a _playback session_. The session returns a stream URL scoped by a _grant_. The web app gives that URL to the browser's media element. The desktop gives MPV a URL on its loopback _bridge_, which answers byte ranges from the _media store_ and fetches what it does not hold from the server. When a client cannot decode a file, the server starts a _conversion_ and streams the result. In the background, the _watcher_ observes each root, diffs it against the catalog in memory, and commits the changes in one transaction fenced by the _library revision_; probing and metadata then run as _jobs_.

Decisions and their alternatives: `docs/adr/`. Setup and releases: `README.md`.

## Where code lives

- `apps/server` - `http/` transport, `services/`, `jobs/` and the watcher, `media/` for ffprobe, FFmpeg, and metadata providers. Built from Effect services and layers.
- `apps/desktop` - Electron. `main/` owns accounts, the bridge and media store, downloads, MPV, and updates; `renderer/` is the desktop adapter.
- `apps/web` - the browser adapter and the Vite build. A build, not a service.
- `packages/app` - the shared React app: routes, pages, and the player view.
- `packages/ui` - presentational components and design tokens.
- `packages/client` - client logic shared by both adapters: the server API, playback, watch groups, media cache rules.
- `packages/contracts` - Effect Schema contracts for the API, IPC, and WebSocket, plus small pure helpers. No heavy runtime logic.
- `packages/database` - Drizzle tables, migrations, and repositories.
- `tests/e2e` - the suites, with fixtures in `support/`. `scripts/` holds check, coverage, and release tooling.

## Taste

- Before adding functionality, check whether shared logic can be extracted to a module. Duplicate logic across files is a code smell. Do not be afraid to change existing code, and do not take the shortcut of local logic that solves only your case.
- Inferred types over annotations. `any` is the enemy, and Biome fails lint on it.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can and four at most. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that.
- React effects are for synchronizing with something outside React. Derive in render and act in handlers instead of syncing state, but don't hide real lifecycle work in refs or stores to dodge one.
- Viewers notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays and compete with the video.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
