import { expect, test } from "bun:test";
import type {
  GroupClientFrame,
  GroupCommandResult,
  GroupServerFrame,
} from "../../packages/contracts/src";
import { WatchGroupConnection } from "../../apps/desktop/src/main/watch-groups/WatchGroupConnection";
import { watchGroupSnapshot } from "../helpers/watch-groups";
import { FakeGroupScheduler } from "../helpers/watch-group-scheduler";
class FakeSocket {
  readyState = WebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly frames: GroupClientFrame[] = [];
  constructor(private readonly handle: (frame: GroupClientFrame, socket: FakeSocket) => void) {}
  send(value: string): void {
    const frame = JSON.parse(value) as GroupClientFrame;
    this.frames.push(frame);
    this.handle(frame, this);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
  receive(frame: GroupServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("reconnect uses a fresh ticket, fresh clocks and the original uncertain command ID", async () => {
  const scheduler = new FakeGroupScheduler();
  const snapshot = watchGroupSnapshot();
  const sockets: FakeSocket[] = [];
  const snapshots: number[] = [];
  let tickets = 0;
  const connection = new WatchGroupConnection({
    scheduler,
    now: () => scheduler.now,
    random: () => 0,
    api: {
      serverOrigin: "http://server",
      watchGroupTicket: async () => ({
        serverInstanceId: snapshot.serverInstanceId,
        ticket: `ticket-${++tickets}`,
      }),
    },
    membership: snapshot,
    onSnapshot: (state) => {
      if (state.playback.type === "playback") snapshots.push(state.playback.state.revision);
    },
    onStatus: () => {},
    socket: () => {
      const socket = new FakeSocket((frame, ws) => {
        if (frame.type === "authenticate")
          ws.receive({ protocolVersion: 1, type: "snapshot", snapshot });
        if (frame.type === "clock-ping")
          ws.receive({
            protocolVersion: 1,
            type: "clock-pong",
            probeId: frame.probeId,
            serverInstanceId: snapshot.serverInstanceId,
            t1: scheduler.now + 50_000,
            t2: scheduler.now + 50_000,
          });
      });
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket as unknown as WebSocket;
    },
  });
  connection.start();
  await flush();
  expect(connection.ready).toBe(true);
  const pending = connection.submit({ type: "stop" });
  const first = sockets[0];
  if (first === undefined) throw new Error("Missing socket");
  const sent = first.frames.find((frame) => frame.type === "command");
  if (sent?.type !== "command") throw new Error("Missing command");
  first.close();
  expect(connection.ready).toBe(false);
  expect(connection.clock.estimate(scheduler.now)).toBeNull();
  await expect(connection.submit({ type: "stop" })).rejects.toThrow("reconnecting");
  scheduler.advance(300);
  await flush();
  const second = sockets[1];
  if (second === undefined) throw new Error("Missing replacement");
  expect(tickets).toBe(2);
  expect(connection.ready).toBe(true);
  const retries = second.frames.filter((frame) => frame.type === "command");
  expect(retries).toHaveLength(1);
  expect(retries[0]).toMatchObject({ command: { commandId: sent.command.commandId } });
  const result: GroupCommandResult = {
    commandId: sent.command.commandId,
    outcome: "accepted",
    code: null,
    revision: 1,
    snapshot,
  };
  second.receive({ protocolVersion: 1, type: "command-result", result });
  expect(await pending).toEqual(result);
  first.receive({
    protocolVersion: 1,
    type: "snapshot",
    snapshot: { ...snapshot, rosterRevision: 99 },
  });
  expect(connection.current()?.rosterRevision).toBe(1);
  connection.dispose();
  expect(scheduler.size).toBe(0);
});

test("obsolete instances and protocol versions end membership instead of restoring an old timeline", async () => {
  const scheduler = new FakeGroupScheduler();
  const snapshot = watchGroupSnapshot();
  const statuses: string[] = [];
  const connection = new WatchGroupConnection({
    scheduler,
    now: () => 0,
    api: {
      serverOrigin: "http://server",
      watchGroupTicket: async () => ({ ticket: "unused", serverInstanceId: crypto.randomUUID() }),
    },
    membership: snapshot,
    onSnapshot: () => {
      throw new Error("Old timeline restored");
    },
    onStatus: (status) => statuses.push(status),
  });
  connection.start();
  await flush();
  expect(statuses).toEqual(["connecting", "ended"]);
  expect(connection.ready).toBe(false);
  expect(scheduler.size).toBe(0);
});
