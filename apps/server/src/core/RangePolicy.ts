export type RangeDecision =
  | { readonly kind: "full"; readonly start: number; readonly end: number; readonly size: number }
  | { readonly kind: "partial"; readonly start: number; readonly end: number; readonly size: number }
  | { readonly kind: "unsatisfiable" }
  | { readonly kind: "ignored" };

const integerPattern = /^\d+$/u;

const parseRange = (header: string, size: number): RangeDecision => {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "unsatisfiable" };
  if (size === 0) return { kind: "unsatisfiable" };
  if (header.length > 1024) return { kind: "ignored" };
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (match === null) return { kind: "ignored" };
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return { kind: "ignored" };
  if (startText !== "" && !integerPattern.test(startText) || endText !== "" && !integerPattern.test(endText)) return { kind: "ignored" };
  const total = BigInt(size);
  if (startText === "") {
    const suffixLength = BigInt(endText);
    if (suffixLength === 0n) return { kind: "unsatisfiable" };
    const start = suffixLength >= total ? 0n : total - suffixLength;
    return { kind: "partial", start: Number(start), end: size - 1, size };
  }
  const start = BigInt(startText);
  if (start >= total) return { kind: "unsatisfiable" };
  if (endText === "") return { kind: "partial", start: Number(start), end: size - 1, size };
  const end = BigInt(endText);
  if (end < start) return { kind: "ignored" };
  const last = total - 1n;
  return { kind: "partial", start: Number(start), end: Number(end > last ? last : end), size };
};

export const decideRange = (header: string | null, size: number): RangeDecision => {
  if (header === null || header.trim() === "") return { kind: "full", start: 0, end: size - 1, size };
  if (header.includes(",")) return { kind: "ignored" };
  return parseRange(header, size);
};

export type ConditionalDecision = "ok" | "not_modified" | "precondition_failed";

export const decideConditional = (options: {
  readonly method: string;
  readonly ifMatch: string | null;
  readonly ifNoneMatch: string | null;
  readonly ifModifiedSince: string | null;
  readonly ifUnmodifiedSince: string | null;
  readonly lastModified: string;
  readonly etag: string;
  readonly nowMs: number;
}): ConditionalDecision => {
  if (options.method === "GET" || options.method === "HEAD") {
    if (options.ifMatch !== null && options.ifMatch !== "*" && !options.ifMatch.split(",").some((v) => v.trim() === options.etag)) {
      return "precondition_failed";
    }
    if (options.ifUnmodifiedSince !== null && Date.parse(options.ifUnmodifiedSince) < Date.parse(options.lastModified)) {
      return "precondition_failed";
    }
    if (options.ifNoneMatch !== null) {
      if (options.ifNoneMatch === "*" || options.ifNoneMatch.split(",").some((v) => v.trim() === options.etag)) {
        return "not_modified";
      }
    } else if (options.ifModifiedSince !== null && Date.parse(options.ifModifiedSince) >= Date.parse(options.lastModified)) {
      return "not_modified";
    }
  }
  return "ok";
};
