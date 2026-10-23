# Production coverage and browser evidence

## Decision

Count JavaScript/TypeScript runtime source in every `apps/*/src` and `packages/*/src` workspace, including entry points and UI modules that Bun cannot execute. Exclude declarations, tests, testkit, generated code, and build output. Build/release scripts and config are tooling, outside this production-runtime metric.

Bun only reports loaded modules. Importing every file as a coverage workaround would start servers or require browser/Electron globals and would give module initialization undeserved credit. Instead, Babel lowers runtime TypeScript and module exports, then Istanbul inventories statements without executing anything. Source maps associate each statement with its first original source location, excluding unmapped compiler glue. Lowering is necessary because parser-only instrumentation misses enums, constructor parameter properties, and default-export expressions. Bun's LCOV supplies the observed line hits. The same static denominator applies to loaded and unloaded files, and missing observations count as zero. Pure type modules remain in the inventory with zero executable statements.

This is **statement-start line coverage**, not branch/function coverage or proof that every expression on a line executed. Raw Bun LCOV remains available separately; browser and native checks are separate evidence, not added to Bun's numerator. The old loaded-file percentage is not comparable to this metric.

Enforce an uncovered-line budget per workspace, seeded from the existing full suite on the base of this change. This preserves current test investment without requiring a broad UI/native test rewrite or choosing an aspirational percentage. Adding covered code cannot dilute the budget, and a new workspace starts with zero allowance. Budget increases require an explicit reviewed baseline change and rationale; improvements should lower the baseline. The gate is not a substitute for reviewing meaningful assertions.

The unit coverage contract is host-independent wherever native dependencies are already faked. macOS window lifecycle tests select the Darwin policy explicitly and restore the host platform after each test, just as the existing Windows policy tests do. Skipping these fake-based tests on Linux measured 679 uncovered desktop lines against macOS's 674, without any production change. Running both policies keeps one production inventory and one unchanged budget; it does not claim native Cocoa/MPV integration coverage. Native integration checks remain separate evidence.

## Bun 1.4.4 coverage baseline

Recalibrate the workspace budgets from the full 697-test suite when upgrading to Bun 1.4.4. Its [coverage fixes](https://bun.com/blog/bun-v1.4.4#bun-test) stop crediting skipped branches and code after an `await` or `yield` that never resumes, and correct other line mappings. The existing budgets were measured with the older reporter. Keep the same production inventory, exclusions, tests, and regression gate; use the corrected uncovered-line counts, including lower budgets where reporting improves. Retaining the old counts would compare different coverage measurements, while disabling the gate would lose regression protection.

Tests must supply configuration explicitly rather than rely on a developer's `.env` to exercise environment overrides. Numeric configuration coverage differed by three lines between a configured workstation and clean CI; explicit default, override, and validation cases keep the same budget enforceable in both environments.

## Browser coverage

Keep the existing H.264/AAC fixture and all playback checks on Chromium. Firefox and WebKit use the same scenes encoded as VP8/Vorbis WebM. Separate fixture servers preserve identical catalog titles and avoid mutating a shared source between engines. No capability-driven skips conceal launch or codec regressions: unsupported playback fails with evidence. Desktop renderer parity intentionally targets Chromium because Electron uses it; its historical baseline is separate maintenance debt.

Retain HTML, JSON, JUnit, and failure screenshots/traces for 14 days on CI success and failure. This keeps pass/skip counts and first-attempt failures reviewable even when no retry runs. Reports and traces use seeded test accounts only.

## Alternatives

- Bun's built-in percentage threshold still omits unloaded files and cannot enforce the production denominator.
- Padding only missing files with a different line-count algorithm makes the denominator change merely when a file is imported. One static statement-line inventory avoids that mismatch.
- Instrumenting the running app and browser would change the execution path being verified. Keeping the production build in browser tests avoids that tradeoff.
- Skipping Firefox/WebKit playback based on codec support leaves the shared player controls unverified. A checked-in open-codec fixture makes the supported engine claim testable.
