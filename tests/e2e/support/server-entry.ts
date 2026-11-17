import "./password-cost";
import "./tmdb-origin";
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
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.once("disconnect", () => void stop());
