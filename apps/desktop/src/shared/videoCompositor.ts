/** Platforms whose video helper renders into textures that the app window composites. */
export const composesVideo = (platform: string): boolean =>
  platform === "win32" || platform === "darwin";
