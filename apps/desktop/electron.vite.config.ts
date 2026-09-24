import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const workspacePackages = ["@lumen/contracts", "@lumen/database", "@lumen/ui"];
const workspaceAlias = {
  "@lumen/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
  "@lumen/database": resolve(__dirname, "../../packages/database/src/index.ts"),
  "@lumen/ui": resolve(__dirname, "../../packages/ui/src/index.ts"),
};

export default defineConfig({
  main: {
    resolve: { alias: workspaceAlias },
    ssr: { noExternal: workspacePackages },
    build: {
      rollupOptions: { external: ["electron", "drizzle-orm", "effect", "koffi"] },
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
      alias: {
        "@lumen/contracts": resolve(__dirname, "../../packages/contracts/src"),
        "@lumen/ui": resolve(__dirname, "../../packages/ui/src"),
      },
    },
  },
});
