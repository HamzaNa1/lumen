import { describe, expect, test } from "bun:test";
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
