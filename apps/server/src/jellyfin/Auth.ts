import type { User } from "@lumen/contracts";
import { Effect } from "effect";
import { badRequest, unauthorized } from "../core/Errors";
import type { AuthPrincipal, AuthServiceShape } from "../services/AuthService";
import type { PlaybackServiceShape } from "../services/PlaybackService";
import { toJellyfinId, uuidV5 } from "./Ids";

/** Names the devices Jellyfin apps sign in from; changing it moves every app to a new device. */
const DEVICE_NAMESPACE = "5f0e8d4c-2b7a-4c1e-9a63-0d8f3e7b6a21";

export interface ClientHeader {
  readonly client?: string | undefined;
  readonly device?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly version?: string | undefined;
  readonly token?: string | undefined;
}

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** `MediaBrowser Client="…", Device="…", DeviceId="…", Version="…", Token="…"`. */
export const parseClientHeader = (value: string | null): ClientHeader => {
  const scheme = /^\s*(?:MediaBrowser|Emby)\s+(.*)$/isu.exec(value ?? "");
  if (scheme === null) return {};
  const fields = new Map<string, string>();
  for (const match of (scheme[1] ?? "").matchAll(/([A-Za-z]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/gu))
    fields.set((match[1] ?? "").toLowerCase(), decode(match[2] ?? match[3] ?? ""));
  const field = (name: string) => {
    const found = fields.get(name);
    return found === undefined || found === "" ? undefined : found;
  };
  return {
    client: field("client"),
    device: field("device"),
    deviceId: field("deviceid"),
    version: field("version"),
    token: field("token"),
  };
};

export const clientHeader = (request: Request): ClientHeader => {
  const primary = parseClientHeader(request.headers.get("authorization"));
  const emby = parseClientHeader(request.headers.get("x-emby-authorization"));
  return { ...emby, ...primary };
};

/**
 * Where Jellyfin apps put the access token. The browser session cookie is never read here, so a
 * page on another site cannot borrow a viewer's web sign-in through these routes.
 */
export const accessToken = (request: Request, query: (name: string) => string | null) =>
  clientHeader(request).token ??
  request.headers.get("x-emby-token") ??
  request.headers.get("x-mediabrowser-token") ??
  query("api_key") ??
  query("apikey");

export const authenticate = async (
  auth: AuthServiceShape,
  request: Request,
  query: (name: string) => string | null,
): Promise<AuthPrincipal> => {
  const token = accessToken(request, query);
  if (token === null || token === "") throw unauthorized();
  return Effect.runPromise(auth.authenticate(token, Date.now()));
};

/**
 * Signs a Jellyfin app in as an ordinary Lumen device. Each app installation and account pair is
 * its own device, so several viewers can share a television, and an administrator sees and
 * revokes it like any other device.
 */
export const signIn = async (
  auth: AuthServiceShape,
  request: Request,
  credentials: { readonly username: string; readonly password: string },
) => {
  const header = clientHeader(request);
  if (header.deviceId === undefined) throw badRequest("The DeviceId header field is required");
  const username = credentials.username.trim();
  const deviceName = (header.device ?? header.client ?? "Jellyfin app").slice(0, 188);
  const session = await Effect.runPromise(
    auth.login(
      {
        username,
        password: credentials.password,
        deviceId: uuidV5(DEVICE_NAMESPACE, `${username.toLowerCase()}\n${header.deviceId}`),
        deviceName: `${deviceName} (Jellyfin)`,
        platform: "other",
        platformDeviceId: header.deviceId.slice(0, 500),
      },
      Date.now(),
    ),
  );
  const principal = await Effect.runPromise(auth.authenticate(session.accessToken, Date.now()));
  return { session, principal, header };
};

export const userDto = async (
  user: User,
  context: {
    readonly serverId: string;
    readonly serverName: string;
    readonly playback: PlaybackServiceShape;
    readonly principal: AuthPrincipal;
  },
) => {
  const preferences = await Effect.runPromise(context.playback.preferences(context.principal));
  return {
    Name: user.username,
    ServerId: context.serverId,
    ServerName: context.serverName,
    Id: toJellyfinId(user.id),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    Configuration: {
      AudioLanguagePreference: preferences.audioLanguage,
      SubtitleLanguagePreference: preferences.subtitleLanguage ?? "",
      PlayDefaultAudioTrack: true,
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: preferences.subtitleLanguage === null ? "None" : "Default",
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      // Administration stays in Lumen's own apps.
      IsAdministrator: false,
      IsHidden: false,
      EnableCollectionManagement: false,
      EnableSubtitleManagement: false,
      EnableLyricManagement: false,
      IsDisabled: !user.isActive,
      BlockedTags: [],
      AllowedTags: [],
      EnableUserPreferenceAccess: false,
      AccessSchedules: [],
      BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: true,
      EnablePlaybackRemuxing: false,
      ForceRemoteSourceTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDeletionFromFolders: [],
      EnableContentDownloading: user.canDownload === true,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnabledDevices: [],
      EnableAllDevices: true,
      EnabledChannels: [],
      EnableAllChannels: false,
      EnabledFolders: [],
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      BlockedMediaFolders: [],
      BlockedChannels: [],
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: "Lumen",
      PasswordResetProviderId: "Lumen",
      SyncPlayAccess: "None",
    },
  };
};

export const sessionInfo = (
  principal: AuthPrincipal,
  header: ClientHeader,
  serverId: string,
  nowMs: number,
) => ({
  Id: toJellyfinId(principal.sessionId),
  UserId: toJellyfinId(principal.user.id),
  UserName: principal.user.username,
  Client: header.client ?? null,
  DeviceId: header.deviceId ?? null,
  DeviceName: header.device ?? null,
  ApplicationVersion: header.version ?? null,
  ServerId: serverId,
  LastActivityDate: new Date(nowMs).toISOString(),
  LastPlaybackCheckIn: new Date(nowMs).toISOString(),
  IsActive: true,
  SupportsMediaControl: false,
  SupportsRemoteControl: false,
  HasCustomDeviceName: false,
  PlayableMediaTypes: ["Video"],
  SupportedCommands: [],
});
