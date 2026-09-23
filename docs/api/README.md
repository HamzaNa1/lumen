# API surface

The server exposes versioned JSON endpoints under `/api/v1`. Account-authenticated routes use opaque bearer access tokens. Media bytes use a separate short-lived playback grant. JSON DTOs never include canonical media paths, token hashes, provider credentials, or SQL errors.
