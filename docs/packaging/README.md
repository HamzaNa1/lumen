# Packaging

The desktop application packages MPV under `resources/native` outside the archive contents. Release builds must verify the native binary manifest and checksums before signing. The server container runs as a non-root user, keeps SQLite on local storage, and expects media mounts to be configured read-only.
