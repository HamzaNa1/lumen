import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MpvProcess } from "../../apps/desktop/src/main/player/MpvProcess";
import { MpvIpc } from "../../apps/desktop/src/main/player/MpvIpc";

const createIpc = (): { readonly ipc: MpvIpc; readonly requestId: () => number } => {
  const ipc = new MpvIpc();
  let requestId: number | undefined;
  Reflect.set(ipc, "socket", {
    write: (message: string) => {
      requestId = (JSON.parse(message) as { request_id: number }).request_id;
    },
    end: () => undefined,
    destroy: () => undefined,
  });
  return {
    ipc,
    requestId: () => {
      if (requestId === undefined) throw new Error("MPV request was not written");
      return requestId;
    },
  };
};

const respond = (ipc: MpvIpc, requestId: number, error?: string, data?: unknown): void => {
  const response: { request_id: number; error?: string; data?: unknown } = { request_id: requestId };
  if (error !== undefined) response.error = error;
  if (data !== undefined) response.data = data;
  Reflect.apply((ipc as unknown as { handle: (line: string) => void }).handle, ipc, [JSON.stringify(response)]);
};

describe("MpvIpc command responses", () => {
  test("resolves a successful command response", async () => {
    const { ipc, requestId } = createIpc();
    const result = ipc.command(["set_property", "pause", "yes"]);

    respond(ipc, requestId(), "success", { applied: true });

    expect(await result).toEqual({ applied: true });
    ipc.close();
  });

  test("resolves null when a response omits the status and data", async () => {
    const { ipc, requestId } = createIpc();
    const result = ipc.command(["set_property", "pause", "yes"]);

    respond(ipc, requestId());

    expect(await result).toBeNull();
    ipc.close();
  });

  test("resolves null for a successful command response with null data", async () => {
    const { ipc, requestId } = createIpc();
    const result = ipc.command(["set_property", "pause", "yes"]);

    respond(ipc, requestId(), "success", null);

    expect(await result).toBeNull();
    ipc.close();
  });

  test("rejects a command response with a non-success error", async () => {
    const { ipc, requestId } = createIpc();
    const result = ipc.command(["loadfile", "missing.mkv", "replace"]);

    respond(ipc, requestId(), "file not found", null);

    await expect(result).rejects.toThrow("file not found");
    ipc.close();
  });
});


test("a real IPC socket disconnect rejects pending and subsequent commands and reports failure once", async () => {
  const connected = Promise.withResolvers<Socket>();
  const server = createServer((socket) => connected.resolve(socket));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\lumen-test-${crypto.randomUUID()}`
    : join(tmpdir(), `lumen-test-${crypto.randomUUID()}.sock`);
  const ipc = new MpvIpc();
  let failures = 0;
  const disconnected = Promise.withResolvers<void>();
  ipc.on("disconnected", () => {
    failures += 1;
    disconnected.resolve();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await ipc.connect({ socketPath } as MpvProcess);
    const socket = await connected.promise;
    socket.once("data", () => socket.destroy());
    const pending = expect(ipc.command(["get_property", "time-pos"])).rejects.toThrow("MPV IPC closed");
    await disconnected.promise;
    await pending;
    await expect(ipc.command(["get_property", "time-pos"])).rejects.toThrow("not connected");
    ipc.close();
    expect(failures).toBe(1);
  } finally {
    ipc.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
