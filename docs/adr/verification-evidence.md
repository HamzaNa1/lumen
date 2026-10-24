# End-to-end verification and coverage

## Decision

Replace the previous Bun suites and browser desktop shims with Playwright scenarios at real execution boundaries: isolated server processes and SQLite files, HTTP/WebSocket clients, Chromium/Firefox/WebKit, Electron IPC and MPV, and release commands in temporary Git repositories. External providers, network faults and downloaded installers use controlled boundary fixtures. Production service classes and media decoders remain real. This makes cross-process races, native shutdown and authentication failures observable instead of asserting mocked call sequences. Related former suites are mapped to their replacement journeys in `tests/e2e/migration.json`.

Keep real browser playback on Chromium's H.264/AAC and Firefox/WebKit's VP8/Vorbis fixtures. Native projects run serially with a graphical session. Linux requires a window manager as well as Xvfb: a bare display cannot acknowledge fullscreen transitions. CI also verifies native macOS and Windows behavior. No automatic retries or codec-driven skips turn a first-attempt failure into a pass.

Measure production **statement-start line coverage** across every `apps/*/src` and `packages/*/src` workspace, including entry points and unloaded modules. Declarations, generated code and build output are excluded. Babel lowers TypeScript while retaining ES modules; Istanbul instruments a temporary checkout that is built and exercised through the same E2E runner. Original source maps define a static denominator. Server, browser, Electron and client process counters contribute observed hits; missing observations count as zero. Tests and fixtures cannot contribute production lines.

Retain the existing per-workspace uncovered-line budgets from the previous 697-test suite. Adding covered code cannot dilute a budget; a new workspace starts with zero allowance. Budget changes require a reviewed rationale. Instrumented statement counters replace Bun's observed-line reporter, so percentages are not historical like-for-like comparisons. Coverage is evidence of execution, not proof of every branch or behavior; assertion quality and the migration map remain review requirements.

Run release scenarios with the candidate product and the latest stable counterpart in separate dependency trees. Copy the candidate tests into that combined workspace so relative fixture imports cannot accidentally resolve the unreleased counterpart. Keep release packaging and publication gated on same-commit verification. Retain HTML, JSON, JUnit, coverage and failure traces/screenshots for 14 days, including failed checks.

Use ten logical PR jobs: Linux server, Chromium/Firefox/WebKit on Linux, native desktop on macOS/Windows/Linux, quality, released-counterpart compatibility, and packaging. Reusable client, compatibility and packaging workflows share implementation with scheduled verification and releases. Twenty-run WebKit flakiness checks run weekly or manually instead of duplicating the PR matrix. Desktop tests retain isolated local servers on their runner OS; a remote Linux server would add fixture provisioning and lifecycle coordination without improving most HTTP/WebSocket assertions.

Collect coverage separately in the Linux API and four client jobs, then union their line hits in the quality job. Require all five successful shards from the same commit and identical source inventory; missing shards and mismatched sources fail closed. Tooling runs in quality without contributing synthetic fixture sources to production coverage. The local `bun run check` still runs the entire suite in one process tree. The stable required `check` gate also requires every other logical job to succeed, including all compatibility and packaging matrix children, so failed or skipped dependencies cannot appear green. Retire the former individual required-check names when applying the updated ruleset at rollout; preserve unrelated required checks.

## Alternatives

- Retaining unit suites alongside E2E would violate the requested replacement and preserve duplicate test architecture.
- Renaming mocked tests to E2E would leave actual browser, native-window, transport and database behavior unverified.
- Keeping coverage limited to Bun imports would omit browser and Electron execution and credit a different runtime than the one under test.
- Instrumenting the working checkout would leave generated changes behind and risk building them into releases. Temporary copies isolate instrumentation; uninstrumented product/native CI checks remain independent evidence.
- A fixed historical renderer shim encodes obsolete capabilities and cannot expose native IPC or MPV failures. Shared routes and controls are checked through the actual browser and Electron applications.
