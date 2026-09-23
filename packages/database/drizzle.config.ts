import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/tables/all.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
