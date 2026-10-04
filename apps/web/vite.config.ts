import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packages = resolve(__dirname, "../../packages");
// The web app has no version of its own: it ships inside a server release and reports that one.
const server = JSON.parse(readFileSync(resolve(__dirname, "../server/package.json"), "utf8")) as {
  version: string;
};

export default defineConfig({
  // The server serves the build under /web, so every script, style and asset URL starts there.
  base: "/web/",
  plugins: [react()],
  define: { __LUMEN_SERVER_VERSION__: JSON.stringify(server.version) },
  resolve: {
    // Most specific first: a longer specifier must not be caught by its package's alias.
    alias: [
      { find: "@lumen/client/runtime", replacement: resolve(packages, "client/src/runtime.ts") },
      { find: "@lumen/client", replacement: resolve(packages, "client/src") },
      { find: "@lumen/contracts", replacement: resolve(packages, "contracts/src") },
      { find: "@lumen/ui", replacement: resolve(packages, "ui/src") },
      { find: "@lumen/app", replacement: resolve(packages, "app/src") },
    ],
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
