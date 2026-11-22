import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const workspacePackages = ["@lumen/contracts", "@lumen/client"];
const workspaceAlias = {
  "@lumen/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
  "@lumen/client": resolve(__dirname, "../../packages/client/src/index.ts"),
};

export default defineConfig({
  main: {
    resolve: { alias: workspaceAlias },
    ssr: { noExternal: [...workspacePackages, "effect"] },
    // The bundle holds ws without its optional native addons; this keeps it on its own JavaScript.
    define: {
      "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
      "process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
    },
    build: {
      rollupOptions: { external: ["electron", "drizzle-orm", "koffi"] },
    },
  },
  preload: {
    resolve: { alias: workspaceAlias },
    ssr: { noExternal: workspacePackages },
    build: {
      rollupOptions: {
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      // Most specific first: a longer specifier must not be caught by its package's alias.
      alias: [
        {
          find: "@lumen/client/runtime",
          replacement: resolve(__dirname, "../../packages/client/src/runtime.ts"),
        },
        { find: "@lumen/client", replacement: resolve(__dirname, "../../packages/client/src") },
        {
          find: "@lumen/contracts",
          replacement: resolve(__dirname, "../../packages/contracts/src"),
        },
        { find: "@lumen/ui", replacement: resolve(__dirname, "../../packages/ui/src") },
        { find: "@lumen/app", replacement: resolve(__dirname, "../../packages/app/src") },
      ],
    },
  },
});
