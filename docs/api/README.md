# API surface

The server exposes versioned JSON endpoints under `/api/v1`. Account-authenticated routes use opaque bearer access tokens. Media bytes use a separate short-lived playback grant. JSON DTOs never include canonical media paths, token hashes, provider credentials, or SQL errors.

Movie and series browsing uses `GET /items?libraryId=…` for top-level items, `GET /items/:id` for details, and `GET /items/:id/children?limit=…&cursor=…` for ordered seasons or episodes. `GET /items/:id/next-up` returns the signed-in user's first unwatched episode in a series. Artwork IDs returned by these routes are fetched through the authenticated `GET /artwork/:id` endpoint.

Administrators can `PATCH /items/:id/metadata` to edit and lock fields, `PUT /items/:id/match` with `{ "tmdbId": "123" }` to correct a movie or series match, and `POST /items/:id/refresh` to queue TMDb enrichment. Set a TMDb v3 API key in Administration or with `PUT /api/v1/admin/metadata-settings` using `{ "tmdbApiKey": "..." }`. The key is stored in the server's SQLite database; its files are restricted to the server's local account. `GET /api/v1/admin/metadata-settings` returns only whether the key is configured. Send `null` to clear it. Saving a key queues enrichment for previously scanned video items without a server restart. Scanning and local browsing work without it.
