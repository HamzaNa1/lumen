export const SUPPORTED_API_RANGE = ">=1.0.0 <2.0.0";

/** The server answered with a failure status. */
export class ServerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServerHttpError";
  }
}

/** The server speaks an API version this app cannot use. */
export class IncompatibleServerError extends Error {
  constructor(readonly apiVersion: string) {
    super(
      `This server uses API ${apiVersion || "(missing)"}; this app supports ${SUPPORTED_API_RANGE}. Update the app or connect to a compatible server.`,
    );
    this.name = "IncompatibleServerError";
  }
}

/** A request was made before signing in. */
export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthenticationRequiredError";
  }
}

/** The request belonged to a session that has since been replaced or signed out. */
export class RequestCancelledError extends Error {
  constructor() {
    super("Request was cancelled");
    this.name = "RequestCancelledError";
  }
}

/** The server could not be reached at all. */
export class ServerUnreachableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Could not reach the server. Check the connection and try again.", options);
    this.name = "ServerUnreachableError";
  }
}

/** Playback cannot work on this device, so retrying the same file will not help. */
export class PlaybackUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackUnsupportedError";
  }
}

export const assertCompatibleApi = (apiVersion: string): void => {
  if (!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(apiVersion)) {
    throw new IncompatibleServerError(apiVersion);
  }
};
