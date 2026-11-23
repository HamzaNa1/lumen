import dns from "node:dns";
import { app } from "electron";

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.error(error);
    app.exit(1);
  });
}
// --host-resolver-rules reaches only Chromium. Node sockets, such as the watch socket, resolve
// through the OS, where macOS spends five seconds asking mDNS for a `.local` name before failing.
const mappedHosts = new Map(
  (process.env.LUMEN_E2E_HOST_RESOLVER_RULES ?? "")
    .split(",")
    .map((rule) => rule.trim().split(/\s+/))
    .filter(([directive]) => directive === "MAP")
    .map(([, host, address]) => [host, address]),
);
if (mappedHosts.size > 0) {
  const lookup = dns.lookup;
  dns.lookup = (hostname, ...rest) => lookup(mappedHosts.get(hostname) ?? hostname, ...rest);
}
app.setPath("userData", process.env.LUMEN_E2E_PROFILE);
if (process.env.LUMEN_E2E_MPV_WIRE === "1") await import("./mpv-wire.mjs");
await import("../../../apps/desktop/out/main/index.js");
