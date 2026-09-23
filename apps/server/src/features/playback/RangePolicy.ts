import { Schema } from "effect";

export const RangeDecision = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Full") }),
  Schema.Struct({ _tag: Schema.Literal("Unsatisfiable") }),
  Schema.Struct({
    _tag: Schema.Literal("Partial"),
    start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    endInclusive: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
export type RangeDecision = typeof RangeDecision.Type;

export function decideByteRange(header: string | null, size: number): RangeDecision {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("File size must be a nonnegative safe integer");
  }
  const full: RangeDecision = { _tag: "Full" };
  const unsatisfiable: RangeDecision = { _tag: "Unsatisfiable" };
  if (header === null || header.length > 1024) return full;

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return full;

  const total = BigInt(size);
  if (match[1] === "") {
    const suffixLength = BigInt(match[2]);
    if (suffixLength === 0n || total === 0n) return unsatisfiable;
    const start = suffixLength >= total ? 0n : total - suffixLength;
    return { _tag: "Partial", start: Number(start), endInclusive: size - 1 };
  }

  const start = BigInt(match[1]);
  const suppliedEnd = match[2] === "" ? null : BigInt(match[2]);
  if (suppliedEnd !== null && suppliedEnd < start) return full;
  if (start >= total) return unsatisfiable;
  const last = total - 1n;
  const end = suppliedEnd === null || suppliedEnd > last ? last : suppliedEnd;
  return { _tag: "Partial", start: Number(start), endInclusive: Number(end) };
}
