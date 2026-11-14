import { once } from "node:events";
import { createConnection } from "node:net";
import { expect, test } from "./support/transport";

test("server transport keeps connections open between requests and closes fresh and reused stalled ones", async ({
  transport: ready,
}) => {
  const { port } = new URL(ready.brief);
  const fresh = createConnection(Number(port), "127.0.0.1");
  const freshClosed = once(fresh, "close", { signal: AbortSignal.timeout(5000) });
  fresh.write("GET / HTTP/1.1\r\n");
  const reused = createConnection(Number(port), "127.0.0.1");
  const reusedClosed = once(reused, "close", { signal: AbortSignal.timeout(5000) });
  let answer = "";
  reused.on("data", (data) => {
    answer += String(data);
  });
  reused.write("GET / HTTP/1.1\r\nHost: brief\r\n\r\n");
  await expect.poll(() => answer.endsWith("\r\n\r\nok")).toBe(true);
  expect(answer.toLowerCase()).toContain("keep-alive: timeout=1\r\n");
  // A request that stops partway on a kept connection is closed, as on a new one.
  reused.write("GET / HTTP/1.1\r\n");
  await Promise.all([freshClosed, reusedClosed]);
});
