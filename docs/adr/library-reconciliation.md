# Library reconciliation

## Decision

Observe each enabled root, compare its files with a library snapshot in memory, and commit the resulting changes in one revision-checked transaction. Unchanged watcher checks neither update timestamps nor create a run. Explicit scans retain their run and retry incomplete ingest; scheduled checks leave unchanged incomplete files alone. Full scans still probe every observed file.

Match absolute paths first, then unmatched files by device, inode, and size, choosing the oldest source ID deterministically. Legacy rows with an unknown device retain inode-and-size matching within their own readable root only. This bounded upgrade exception preserves existing same-root rename behavior until observation records the device; cross-root matching always requires a known device. A pre-upgrade move across roots cannot be verified from the old data. Only completely observed, readable locations may supply moves or deletions. Keep sources on unavailable or suspiciously empty roots, preserve unreadable subtrees, and recheck missing paths immediately before deletion. Source path uniqueness is per root: two roots can contain the same relative path, including a destination whose original source is on an unavailable volume.

A library revision fences the entire plan. Capture it with root configuration before observation, verify it again after the snapshot, and compare-and-increment it as the transaction's first write. Database triggers increment the same revision when roots are added, removed, moved, enabled, or disabled, including writes outside LibraryService. Changing library enablement also invalidates plans. Retry stale plans once; sustained contention waits for the next check. A discovery retry after commit keeps its original statistics and probe jobs.

Batch inserts inside the transaction keep parameter counts bounded without sacrificing atomicity. The local 20k-file benchmark measured a 0.81-second apply and 1.12-second first import, so splitting imports across transactions is unnecessary. Keep this decision measurable with the benchmark harness; substantially larger libraries can hold the writer longer.

Migration backfills run statistics before dropping per-file history and cancels obsolete active discovery work while preserving probe and metadata jobs. Historical cleanup jobs remain stored for retention but are excluded from current job APIs, whose operation contract now contains discovery, probe, and metadata only. A manual `db:compact` command reclaims freed pages; startup never compacts the database.

The backfill stores aggregated summaries in a temporary table with an explicit primary key. Depending on an automatic index over a materialized CTE produced repeated summary scans in Bun's SQLite planner on the lab database; the explicit index keeps lookup cost bounded across SQLite versions. A 25,000-run migration regression exercises this scale without a large media fixture.

The read-only job-log response accepts operation names from other server versions, with a plain-text fallback label. Keeping this response restricted to currently executable operations breaks a new desktop connected to an older server that still returns cleanup jobs. Job creation and execution remain restricted to the current operation set.

Pure diff cases run without filesystem or database access under the existing Playwright runner, alongside process tests for filesystem errors, transaction failure, leases, recovery, retention, and migration. This adds the requested unit seam without introducing a second CI test runner.

## Alternatives

- **Delete seen rows when a run completes.** Bounds retained history but still writes every file on every check, creates empty runs, and adds completion/retention recovery work.
- **Store a last-seen run on each source.** Removes the join table but still updates every unchanged source and needs generations to distinguish stale cleanup from current discovery.
- **In-memory diff.** Reads the filesystem and catalog once, writes only changes, and makes matching and deletion rules independently testable. It costs memory proportional to library size and still walks network mounts.
- **Commit new sources in separate chunks.** Reduces the longest writer hold but exposes partial imports and complicates revision fencing. The measured 20k-file transaction stays below the two-second threshold, so retain all-or-nothing apply.
