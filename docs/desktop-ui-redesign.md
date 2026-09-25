# Desktop UI redesign

This change reshapes the desktop client into a quieter, consistent media app and splits the renderer into focused page modules.

## What changed

- Replaced the blue tinted palette, lime accents, decorative glows, and large marketing style headings with neutral dark surfaces, restrained lime actions, consistent radii, and a compact type scale.
- Reworked shared UI components for buttons, menus, account selection, status and empty states, media cards, controls, and playback.
- Split the renderer into separate modules for browse, library, search, details, settings, administration, job logs, and playback.
- Added library specific browsing, continue watching, debounced search, infinite loading, grouped job runs, and dialog based user and library editing.
- Moved server selection, settings, adding a server, and sign out into the account menu.
- Fixed search results to include artwork and watch state, corrected the single library response schema, and aligned native window chrome with the dark theme.
- Playback Back returns to the page playback started from.

## Screenshots

The before and after gallery is in [docs/screenshots/desktop-ui-redesign](screenshots/desktop-ui-redesign/README.md). It contains 15 baseline captures and 31 redesigned states across the connect flow, browsing, item details, settings, administration, job states, and player.

The current player capture combines the live overlay UI with a matching sample video frame because the native video surface is not included in browser page screenshots.

## Validation

- `bun run check` passed in the existing check log: lint, all workspace typechecks, 51 tests across 13 files, and production builds.
- The Electron app was reopened on the current worktree. Playback was started from Movies, then Back was clicked; the app returned to that Movies library.
- Screenshots were captured from an isolated local demo library. Demo credentials and local paths are not included here.

## Known follow ups

- The server does not currently provide `durationSeconds`, so runtimes and most card progress bars remain hidden until that data is available.
- Episode search results do not include their parent show title.
- Continue watching currently covers top level items only because library listings exclude child episodes.
