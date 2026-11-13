import {
  DevicePlatform,
  GrantCapability,
  LibraryAccess,
  LibraryScanMode,
  NewPassword,
  NonEmptyText,
  UserRole,
  UtcMillis,
  Uuid,
} from "@lumen/contracts";
import { Schema } from "effect";

const Identifier = Uuid;
const Text = NonEmptyText;

export const LoginBody = Schema.Struct({
  username: Text,
  password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  deviceId: Identifier,
  deviceName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  platform: DevicePlatform,
  platformDeviceId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});

export const RegisterBody = Schema.Struct({
  username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  password: NewPassword,
  deviceId: Identifier,
  deviceName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  platform: DevicePlatform,
  platformDeviceId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});

// A browser never names its platform or receives a token: both are the server's to decide.
export const BrowserLoginBody = Schema.Struct({
  username: Text,
  password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  deviceId: Identifier,
  deviceName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const BrowserRegisterBody = Schema.Struct({
  username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  password: NewPassword,
  deviceId: Identifier,
  deviceName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const LegacySessionBody = Schema.Struct({
  refreshToken: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(1024)),
});

export const LogoutBody = Schema.Struct({ sessionId: Identifier });
export const SessionPath = Schema.Struct({ sessionId: Identifier });
export const UserIdPath = Schema.Struct({ userId: Identifier });
export const UserPath = Schema.Struct({ id: Identifier });
export const LibraryPath = Schema.Struct({ libraryId: Identifier });
export const LibraryIdPath = Schema.Struct({ id: Identifier });
export const RootPath = Schema.Struct({ rootId: Identifier });
export const TrackPath = Schema.Struct({ trackId: Identifier });
export const ArtworkPath = Schema.Struct({ artworkId: Identifier });
export const SidecarPath = Schema.Struct({ sidecarId: Identifier });
export const ScanPath = Schema.Struct({ runId: Identifier });
export const PlaybackPath = Schema.Struct({ sessionId: Identifier });

export const PaginationQuery = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  cursor: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  ),
});

export const SearchQuery = Schema.Struct({
  q: Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/u), Schema.isMaxLength(500)),
  libraryId: Schema.NullOr(Identifier),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  cursor: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  ),
});

export const ServerRenameBody = Schema.Struct({
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const CreateUserBody = Schema.Struct({
  username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  password: NewPassword,
  role: Schema.optional(UserRole),
  libraryAccess: Schema.optional(LibraryAccess),
  canDownload: Schema.optional(Schema.Boolean),
});

export const UpdateUserBody = Schema.Struct({
  displayName: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  password: Schema.optional(NewPassword),
  role: Schema.optional(UserRole),
  libraryAccess: Schema.optional(LibraryAccess),
  isActive: Schema.optional(Schema.Boolean),
  canDownload: Schema.optional(Schema.Boolean),
});

const FolderPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

export const CreateLibraryBody = Schema.Struct({
  id: Identifier,
  name: Text,
  slug: Schema.String.check(
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    Schema.isMaxLength(100),
  ),
  kind: Schema.optional(Schema.Literals(["movies", "shows", "music"])),
  /** The library's first folder, added in the same transaction. Older clients add it afterwards. */
  root: Schema.optional(Schema.Struct({ id: Identifier, path: FolderPath })),
});

export const UpdateLibraryBody = Schema.Struct({
  name: Schema.optional(Text),
  slug: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u), Schema.isMaxLength(100)),
  ),
  kind: Schema.optional(Schema.Literals(["movies", "shows", "music"])),
  isEnabled: Schema.optional(Schema.Boolean),
});

export const CreateRootBody = Schema.Struct({
  id: Identifier,
  libraryId: Identifier,
  path: FolderPath,
  priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  /** A root of the same library that the new one replaces in the same transaction. */
  replacesRootId: Schema.optional(Identifier),
});

export const CreateGrantBody = Schema.Struct({
  id: Identifier,
  libraryId: Identifier,
  userId: Identifier,
  capabilities: Schema.Array(GrantCapability),
  /** @deprecated Accepted for older clients; download permission belongs to the user. */
  canDownload: Schema.optional(Schema.Boolean),
  expiresAtMs: Schema.NullOr(UtcMillis),
});

export const StartScanBody = Schema.Struct({
  libraryId: Identifier,
  mode: LibraryScanMode,
});

export const StartPlaybackBody = Schema.Struct({
  trackId: Schema.NullOr(Identifier),
});

export const CreateDownloadBody = Schema.Struct({ itemId: Identifier });

export const PreloadBody = Schema.Struct({ itemId: Identifier });

export const HeartbeatBody = Schema.Struct({
  state: Schema.Literals(["idle", "playing", "paused", "buffering", "ended", "error"]),
  activeTrackId: Schema.NullOr(Identifier),
  errorCode: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/u)))),
});

export const ProgressBody = Schema.Struct({
  trackId: Identifier,
  positionMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const FavoriteBody = Schema.Struct({ isFavorite: Schema.Boolean });
export const WatchStateBody = Schema.Struct({
  positionMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completed: Schema.Boolean,
});

export const ItemWatchStateBody = Schema.Struct({
  positionSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completed: Schema.Boolean,
  /**
   * When a device saw this state, for one that was offline at the time. It applies only over a
   * state the server last changed before then, so a late device cannot undo newer progress.
   */
  observedAtMs: Schema.optional(UtcMillis),
});

export const ItemMetadataBody = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  overview: Schema.optional(Schema.NullOr(Schema.String)),
  year: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1800, maximum: 9999 }))),
  ),
  releaseDate: Schema.optional(Schema.NullOr(Schema.String)),
  contentRating: Schema.optional(Schema.NullOr(Schema.String)),
  communityRating: Schema.optional(Schema.NullOr(Schema.Number)),
  genres: Schema.optional(Schema.Array(Schema.String)),
  studios: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
});

export const EventsQuery = Schema.Struct({
  after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const EmptyBody = Schema.Struct({});
export const IdBody = Schema.Struct({ id: Identifier });
export const Message = Schema.Struct({ message: Schema.String, requestId: Schema.String });
export const Ack = Schema.Struct({ ok: Schema.Boolean, nowMs: UtcMillis });
