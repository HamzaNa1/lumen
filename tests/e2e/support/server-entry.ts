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

const schedulerTickMs = Number(process.env.LUMEN_E2E_SCHEDULER_TICK_MS);
const watchTimers = process.env.LUMEN_E2E_WATCH_TIMERS;
const discoveryPortRaw = process.env.LUMEN_E2E_DISCOVERY_PORT;
const lanDiscoveryPort =
  discoveryPortRaw === undefined || discoveryPortRaw === "" ? undefined : Number(discoveryPortRaw);
const server = await startServer({
  port: 0,
  ...(Number.isSafeInteger(schedulerTickMs) && schedulerTickMs > 0 ? { schedulerTickMs } : {}),
  ...(watchTimers === undefined ? {} : { watchTimers: JSON.parse(watchTimers) }),
  ...(lanDiscoveryPort !== undefined && Number.isSafeInteger(lanDiscoveryPort)
    ? { lanDiscoveryPort }
    : {}),
});
process.send?.({
  origin: server.server.url.toString(),
  discoveryPort: server.discoveryPort,
});
const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.once("disconnect", () => void stop());
