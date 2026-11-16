import { app } from "electron";

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.error(error);
    app.exit(1);
  });
}
app.setPath("userData", process.env.LUMEN_E2E_PROFILE);
if (process.env.LUMEN_E2E_MPV_WIRE === "1") await import("./mpv-wire.mjs");
await import("../../../apps/desktop/out/main/index.js");
