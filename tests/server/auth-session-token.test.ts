import { expect, test } from "bun:test";
import {
  createSessionToken,
  sessionIdFromToken,
  verifySessionToken,
} from "../../apps/server/src/services/AuthSessionToken";

test("generated tokens identify their session and verify only with its hash", () => {
  const session = createSessionToken();
  expect(sessionIdFromToken(session.token)).toBe(session.id);
  expect(verifySessionToken(session.token, session.id, session.secretHash)).toBe(true);
  expect(verifySessionToken(session.token, crypto.randomUUID(), session.secretHash)).toBe(false);
  expect(verifySessionToken(session.token, session.id, createSessionToken().secretHash)).toBe(
    false,
  );
  expect(verifySessionToken(session.token, session.id, "00")).toBe(false);
});

test("malformed and noncanonical token secrets are rejected", () => {
  const session = createSessionToken();
  for (const token of [
    session.id,
    `${session.id}.`,
    `${session.token}.extra`,
    `${session.id}.${"!".repeat(43)}`,
  ])
    expect(verifySessionToken(token, session.id, session.secretHash)).toBe(false);
  // The last base64url digit contains two padding bits, which must both be zero.
  const noncanonical = `${session.id}.${"A".repeat(42)}B`;
  expect(verifySessionToken(noncanonical, session.id, session.secretHash)).toBe(false);
  expect(sessionIdFromToken("short")).toBeNull();
  expect(sessionIdFromToken("x".repeat(80))).toBeNull();
  expect(sessionIdFromToken(`${"x".repeat(36)}.${"A".repeat(43)}`)).toBeNull();
});
