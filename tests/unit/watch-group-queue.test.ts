import { expect, test } from "bun:test";
import { GroupQueue } from "../../apps/server/src/features/watch-groups/GroupQueue";
import { ConnectionTickets } from "../../apps/server/src/features/watch-groups/ConnectionTickets";
test("bounded serial work survives a failed command without admitting two stale writers", async () => {
  const queue = new GroupQueue(2);
  let release = () => {};
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let revision = 0;
  const first = queue.run(async () => {
    await blocked;
    revision++;
  });
  const second = queue.run(() => {
    expect(revision).toBe(1);
    throw new Error("stale");
  });
  const rejected = second.catch((error: Error) => error.message);
  await expect(queue.run(() => {})).rejects.toThrow("busy");
  release();
  await first;
  expect(await rejected).toBe("stale");
  expect(await queue.run(() => revision)).toBe(1);
});
test("connection tickets are single use, bounded and expire", () => {
  let now = 0;
  const tickets = new ConnectionTickets(1, 30_000, () => now);
  const binding = {
    groupId: "group",
    membershipId: "member",
    sessionId: "session",
    userId: "user",
    deviceId: "device",
    serverInstanceId: "instance",
  };
  const token = tickets.issue(binding);
  expect(() => tickets.issue(binding)).toThrow("Too many");
  expect(tickets.consume(token)).toEqual(binding);
  expect(() => tickets.consume(token)).toThrow("expired");
  const expired = tickets.issue(binding);
  now = 30_000;
  expect(() => tickets.consume(expired)).toThrow("expired");
});
