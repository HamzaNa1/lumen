# Durable SQLite jobs

Scans and probes use SQLite jobs with idempotency keys, lease ownership, conditional completion, and bounded retry. The in-memory wake-up loop is only a scheduler; durable state is the recovery source of truth.
