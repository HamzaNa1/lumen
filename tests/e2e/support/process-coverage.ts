import { writeFileSync } from "node:fs";
import { join } from "node:path";

process.on("exit", () => {
  if (process.env.LUMEN_COVERAGE_DIR)
    writeFileSync(
      join(process.env.LUMEN_COVERAGE_DIR, `${crypto.randomUUID()}.json`),
      JSON.stringify(
        (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__ ?? {},
      ),
    );
});
