import { describe, expect, test } from "bun:test";
import { Schema } from "../../packages/contracts/node_modules/effect/dist/index.js";
import { CreateTrack, SearchCatalog } from "../../packages/contracts/src/index.ts";
import { fixtures } from "../../packages/testkit/src/index.ts";

const decode = Schema.decodeUnknownSync(CreateTrack);

describe("shared contracts", () => {
  test("accepts deterministic fixtures", () => {
    expect(decode(fixtures.createTrack)).toEqual(fixtures.createTrack);
  });

  test("rejects negative duration and malformed identifiers", () => {
    expect(() => decode({ ...fixtures.createTrack, durationMs: -1 })).toThrow();
    expect(() => decode({ ...fixtures.createTrack, id: "not-a-uuid" })).toThrow();
  });

  test("rejects blank search terms", () => {
    const decodeSearch = Schema.decodeUnknownSync(SearchCatalog);
    expect(() => decodeSearch({ query: "   ", libraryId: null, limit: 10, offset: 0 })).toThrow();
  });
});
