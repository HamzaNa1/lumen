# Managed browser streaming remains opt-in

Managed delivery uses complete, disposable HLS VOD packages produced by stream copy. Auto continues to use direct playback, and desktop playback retains its direct URL contract. Transcoding, adaptive quality, additional codecs, and native HLS are deferred.

A completed package makes every seek target available before playback starts and avoids publishing partial output after preparation failures. The cost is a cold-start delay and disk usage proportional to the source. Incremental packaging would shorten startup but would require a separate design for far seeks, cancellation, and incomplete timelines. The small browser benchmark corpus is a regression baseline, not evidence for promoting Managed to Auto. Promotion requires representative source sizes and keyframe layouts, throttled cold/warm measurements, and real Safari/iOS smoke coverage.

Preparation is owned by one server process, with one active child and a bounded queue. SQLite's exclusive OS-backed cache lock prevents competing server processes from mutating the cache and releases on crashes. Existing persistent scan jobs were considered, but their retry and lease semantics do not own playback waiters or child cancellation; abandoned preparations are discarded rather than automatically restarted.

Cache identity includes source and stream IDs, canonical path, file size, modification/change times, device/inode, and the profile version. Same-size replacements that preserve modification time still invalidate through change time. A content hash would require another full source read; metadata-preserving filesystem snapshot restoration is outside this identity model and requires clearing the disposable cache.

Encoded-buffer estimates count retained segments and conservative segment alignment. They are not measurements of MSE allocation or decoder memory. Original-quality files that cannot satisfy the segment and buffer limits are refused, with direct fallback only when the browser can play the original file.
