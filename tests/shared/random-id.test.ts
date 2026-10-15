import { afterEach, expect, spyOn, test } from "bun:test";
import { randomId } from "../../packages/client/src/index.ts";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

test("a page served over plain HTTP, without crypto.randomUUID, still gets version 4 UUIDs", () => {
  const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  restore.push(() => {
    if (original === undefined) Reflect.deleteProperty(crypto, "randomUUID");
    else Object.defineProperty(crypto, "randomUUID", original);
  });
  const random = spyOn(crypto, "getRandomValues");
  restore.push(() => random.mockRestore());
  const ids = new Set(Array.from({ length: 32 }, () => randomId()));
  expect(random).toHaveBeenCalled();
  expect(ids.size).toBe(32);
  for (const id of ids) expect(id).toMatch(uuidV4);
});
