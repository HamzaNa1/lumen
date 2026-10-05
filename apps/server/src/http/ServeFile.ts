import { lstat } from "node:fs/promises";
import { notFound } from "../core/Errors";
import { decideConditional, decideRange } from "../core/RangePolicy";

const date = (value: number): string => new Date(value).toUTCString();

export interface ServeFileOptions {
  readonly request: Request;
  readonly path: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly mimeType: string;
  /** Defaults to private revalidation, which suits files only their owner may see. */
  readonly cacheControl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Answers GET and HEAD for one file, honouring conditional and range requests. */
export const serveFile = async (options: ServeFileOptions): Promise<Response> => {
  const details = await lstat(options.path).catch(() => {
    throw notFound("File is unavailable");
  });
  if (!details.isFile() || details.isSymbolicLink()) throw notFound("File is unavailable");
  const etag = `W/"${options.size.toString(16)}-${Math.trunc(options.modifiedAtMs).toString(16)}"`;
  const lastModified = date(options.modifiedAtMs);
  const condition = decideConditional({
    method: options.request.method,
    ifMatch: options.request.headers.get("if-match"),
    ifNoneMatch: options.request.headers.get("if-none-match"),
    ifModifiedSince: options.request.headers.get("if-modified-since"),
    ifUnmodifiedSince: options.request.headers.get("if-unmodified-since"),
    lastModified,
    etag,
    nowMs: Date.now(),
  });
  const common = {
    "accept-ranges": "bytes",
    "cache-control": options.cacheControl ?? "private, max-age=0, must-revalidate",
    etag,
    "last-modified": lastModified,
    "content-type": options.mimeType,
    "x-content-type-options": "nosniff",
    ...options.headers,
  };
  if (condition === "precondition_failed")
    return new Response(null, { status: 412, headers: common });
  if (condition === "not_modified") return new Response(null, { status: 304, headers: common });
  const ifRange = options.request.headers.get("if-range");
  const rangeHeader =
    options.request.method === "HEAD" || (ifRange !== null && ifRange !== etag)
      ? null
      : options.request.headers.get("range");
  const range = decideRange(rangeHeader, options.size);
  if (range.kind === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...common, "content-range": `bytes */${options.size}` },
    });
  if (options.size === 0) {
    return new Response(null, { status: 200, headers: { ...common, "content-length": "0" } });
  }
  const start = range.kind === "ignored" || range.kind === "full" ? 0 : range.start;
  const end =
    range.kind === "ignored" || range.kind === "full" ? Math.max(0, options.size - 1) : range.end;
  const bodyFile = Bun.file(options.path).slice(start, options.size === 0 ? 0 : end + 1);
  const headers: Record<string, string> = {
    ...common,
    "content-length": String(Math.max(0, end - start + 1)),
  };
  if (range.kind === "partial") headers["content-range"] = `bytes ${start}-${end}/${options.size}`;
  if (options.request.method === "HEAD" || options.size === 0)
    return new Response(null, { status: range.kind === "partial" ? 206 : 200, headers });
  return new Response(bodyFile, { status: range.kind === "partial" ? 206 : 200, headers });
};
