export const SUPPORTED_API_RANGE = ">=1.0.0 <2.0.0";

export class IncompatibleServerError extends Error {
  constructor(readonly apiVersion: string) {
    super(
      `This server uses API ${apiVersion || "(missing)"}; Lumen Desktop supports ${SUPPORTED_API_RANGE}. Update the desktop app or connect to a compatible server.`,
    );
    this.name = "IncompatibleServerError";
  }
}

export const assertCompatibleApi = (apiVersion: string): void => {
  if (!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(apiVersion)) {
    throw new IncompatibleServerError(apiVersion);
  }
};
