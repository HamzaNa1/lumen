# Opaque rotating sessions

Access and refresh credentials are opaque random values. Only SHA-256 token digests are stored. Refresh tokens rotate transactionally, reuse revokes the family, and the desktop main process performs single-flight refresh per connection.
