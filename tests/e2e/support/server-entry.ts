import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../../apps/server/src/Runtime";

const upstream = process.env.LUMEN_E2E_TMDB_ORIGIN;
if (upstream) {
  const fetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.themoviedb.org" || url.hostname === "image.tmdb.org")
        return fetch(new URL(url.pathname + url.search, upstream), init);
      return fetch(input, init);
    },
    fetch,
  );
}
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
