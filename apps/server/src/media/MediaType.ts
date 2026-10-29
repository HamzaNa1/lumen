import mime from "mime";

export const mediaType = (path: string): string | null => {
  const type = mime.getType(path);
  return type === "audio/x-flac" ? "audio/flac" : type;
};
