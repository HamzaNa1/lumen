# Architecture decision records

The records in this directory record the decisions that are implemented by the server, database, and desktop packages. The prerelease dependency decision is deliberate: Effect `4.0.0-beta.83` is paired with Drizzle `1.0.0-rc.4` because RC4 is the verified native Bun SQLite Effect driver. The pair is pinned and compatibility-tested; it is not represented as a literal beta-only pair.
