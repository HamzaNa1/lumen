import { createServer } from "node:http";

const [moduleUrl, diagnosticsUrl, origin] = process.argv.slice(2);
const { PlaybackBridge } = await import(moduleUrl);
const { PlaybackDiagnostics } = await import(diagnosticsUrl);
const bridge = new PlaybackBridge();
await bridge.listen();
const diagnostics = new PlaybackDiagnostics();
const registered = bridge.register({
  connectionId: "benchmark",
  serverClient: { serverOrigin: origin },
  streamPath: "/api/v1/media/benchmark",
  bearer: "benchmark",
  active: () => true,
  diagnostics,
  sessionId: "benchmark-session",
});
let cpu = process.cpuUsage();
let peakRss = 0;
let sample;
const admin = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/begin") {
    clearInterval(sample);
    cpu = process.cpuUsage();
    peakRss = process.memoryUsage().rss;
    sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 10);
    response.end("{}");
  } else if (request.url === "/stats") {
    clearInterval(sample);
    const usage = process.cpuUsage(cpu);
    response.end(
      JSON.stringify({
        cpuMs: (usage.user + usage.system) / 1000,
        peakRssMiB: peakRss / 1048576,
        activeTransfers: bridge.activeTransferCount ?? null,
        diagnosticsEvents: diagnostics.snapshot().length,
      }),
    );
  } else if (request.url === "/revoke") {
    bridge.revoke(registered.capability);
    response.end("{}");
  } else if (request.url === "/quit") {
    response.end("{}");
    void bridge.close().then(() => admin.close(() => process.exit(0)));
  } else response.writeHead(404).end();
});
await new Promise((resolve) => admin.listen(0, "127.0.0.1", resolve));
console.log(
  JSON.stringify({ url: registered.url, admin: `http://127.0.0.1:${admin.address().port}` }),
);
