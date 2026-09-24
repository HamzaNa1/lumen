export const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  device: "00000000-0000-4000-8000-000000000002",
  authSession: "00000000-0000-4000-8000-000000000003",
  library: "00000000-0000-4000-8000-000000000007",
  libraryRoot: "00000000-0000-4000-8000-000000000008",
  libraryGrant: "00000000-0000-4000-8000-000000000009",
  source: "00000000-0000-4000-8000-000000000010",
  stream: "00000000-0000-4000-8000-000000000011",
  chapter: "00000000-0000-4000-8000-000000000012",
  sidecar: "00000000-0000-4000-8000-000000000013",
  artist: "00000000-0000-4000-8000-000000000014",
  album: "00000000-0000-4000-8000-000000000015",
  track: "00000000-0000-4000-8000-000000000016",
  artwork: "00000000-0000-4000-8000-000000000017",
  watchState: "00000000-0000-4000-8000-000000000018",
  playbackSession: "00000000-0000-4000-8000-000000000019",
  playbackGrant: "00000000-0000-4000-8000-000000000020",
  scanRun: "00000000-0000-4000-8000-000000000021",
  scanJob: "00000000-0000-4000-8000-000000000022",
  outboxEvent: "00000000-0000-4000-8000-000000000023",
} as const;

export const times = {
  epochMs: 1_700_000_000_000,
  minuteMs: 60_000,
  hourMs: 3_600_000,
  dayMs: 86_400_000,
} as const;

export const digests = {
  password: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  session: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  playbackGrant: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  sidecar: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  artwork: "1111111111111111111111111111111111111111111111111111111111111111",
} as const;
