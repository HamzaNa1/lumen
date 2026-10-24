import "./tmdb-origin";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../../apps/server/src/Runtime";

const wallClock = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => wallClock() + clockOffset;
process.on("message", (message: { id?: string; advanceMs?: number }) => {
  if (message.id && Number.isSafeInteger(message.advanceMs) && (message.advanceMs ?? -1) >= 0) {
    clockOffset += message.advanceMs ?? 0;
    process.send?.({ id: message.id });
  }
});

const server = await startServer({ port: 0 });
process.send?.({ origin: server.server.url.toString() });
const stop = async () => {
  await server.stop();
  if (process.env.LUMEN_COVERAGE_DIR)
    writeFileSync(
      join(process.env.LUMEN_COVERAGE_DIR, `${crypto.randomUUID()}.json`),
      JSON.stringify(
        (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__ ?? {},
      ),
    );
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.once("disconnect", () => void stop());
