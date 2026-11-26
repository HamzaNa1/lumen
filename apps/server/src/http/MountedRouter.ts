import type { AdaptiveStreams } from "../media/AdaptiveStreams";
import type { Transcoder } from "../media/Transcoder";
import type { serveArtwork } from "./ServeArtwork";
import type { serveFile } from "./ServeFile";

/**
 * Decides how the HTTP app admits a request: `media` gets media admission and may outlive the idle
 * timeout, `login` gets the sign-in rate limit, and `api` the ordinary limiter.
 */
export type RequestLabel = "media" | "login" | "api";

/** What a router needs to deliver media under the same limits as the native API. */
export interface MediaToolkit {
  /** Counts a media request against its viewer and playback session; call the result when done. */
  readonly admit: (request: Request, userId: string, sessionId: string) => () => void;
  readonly serveFile: typeof serveFile;
  readonly serveArtwork: (
    options: Omit<Parameters<typeof serveArtwork>[0], "variants">,
  ) => Promise<Response>;
  readonly adaptiveStreams: AdaptiveStreams;
  readonly transcoder: Transcoder;
}

export interface MountedRouter {
  /** The first router that owns a request answers it; the native API owns everything else. */
  readonly owns: (url: URL) => boolean;
  readonly label: (request: Request) => RequestLabel;
  /** A bounded name for logs, without identifiers. */
  readonly route: (request: Request) => string;
  readonly handle: (request: Request) => Promise<Response>;
}

export type MountRouter = (toolkit: MediaToolkit) => MountedRouter;
