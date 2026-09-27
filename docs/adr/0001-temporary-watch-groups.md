# Temporary, server-authoritative watch groups

Status: accepted

Watch groups belong to one running server process. The server owns their timeline and serializes equal-rights member controls. Each viewer keeps their own authenticated playback session and existing library permissions.

Membership survives a disconnected socket for 30 seconds. The last live connection leaving freezes playback; groups expire after five empty minutes. A process restart ends the group, identified by a new server instance ID. Rejoining requires a fresh membership and, when configured, the group password.

We chose this scope because Lumen currently runs one server process. It gives command ordering and resource ownership a single, explicit authority without implying cross-process consistency or durable recovery.

Alternatives considered:

- Persisted groups would survive restarts, but require a separate recovery policy for timeline anchors, credentials, memberships, and vanished media.
- Distributed ownership would support multiple server processes, but requires coordinated leadership, routing, and durable command deduplication.
- Client leadership would reduce server timeline work, but makes control availability and recovery depend on the selected viewer.

Persistence and distributed ownership remain future architectural changes. No client silently recreates a group after restart.
