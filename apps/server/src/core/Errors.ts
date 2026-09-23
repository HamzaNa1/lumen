import { Data } from "effect";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media_type"
  | "service_unavailable"
  | "internal";

export class ServerError extends Data.TaggedError("ServerError")<{
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const badRequest = (message: string) =>
  new ServerError({ status: 400, code: "bad_request", message });
export const unauthorized = (message = "Authentication required") =>
  new ServerError({ status: 401, code: "unauthorized", message });
export const forbidden = (message = "Access denied") =>
  new ServerError({ status: 403, code: "forbidden", message });
export const notFound = (message = "Not found") =>
  new ServerError({ status: 404, code: "not_found", message });
export const conflict = (message: string) =>
  new ServerError({ status: 409, code: "conflict", message });
export const internal = (message: string, cause?: unknown) =>
  new ServerError({ status: 500, code: "internal", message, cause });
