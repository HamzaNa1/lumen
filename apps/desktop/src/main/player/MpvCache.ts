/** Provisional read-ahead profile, shared by subprocess mpv and libmpv. Bytes also bound time. */
export const mpvCacheArguments = [
  "--cache=yes",
  "--cache-secs=60",
  "--demuxer-max-bytes=256MiB",
  "--demuxer-max-back-bytes=32MiB",
  "--cache-pause=yes",
  "--cache-pause-wait=2",
  "--cache-pause-initial=no",
] as const;
