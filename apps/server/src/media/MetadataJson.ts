import { Schema } from "effect";

const StringList = Schema.Array(Schema.String);
const StringMap = Schema.Record(Schema.String, Schema.String);

const parse = (value: string | null): unknown => {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export const decodeMetadataList = (value: string | null): ReadonlyArray<string> => {
  try {
    return Schema.decodeUnknownSync(StringList)(parse(value));
  } catch {
    return [];
  }
};

export const decodeMetadataMap = (value: string | null): Record<string, string> => {
  try {
    return { ...Schema.decodeUnknownSync(StringMap)(parse(value)) };
  } catch {
    return {};
  }
};
