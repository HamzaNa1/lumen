import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.error(error);
    app.exit(1);
  });
}
process.on("exit", () => {
  if (process.env.LUMEN_COVERAGE_DIR)
    writeFileSync(
      join(process.env.LUMEN_COVERAGE_DIR, `${crypto.randomUUID()}.json`),
      JSON.stringify(globalThis.__coverage__ ?? {}),
    );
});
app.setPath("userData", process.env.LUMEN_E2E_PROFILE);
await import("../../../apps/desktop/out/main/index.js");
