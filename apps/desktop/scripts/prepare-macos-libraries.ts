import { resolve } from "node:path";
import { prepareMacosLibraries } from "./lib/macos-libraries";

const [directory, ...extra] = process.argv.slice(2);
if (process.platform !== "darwin" || !directory || extra.length > 0)
  throw new Error("Usage (macOS): bun prepare-macos-libraries.ts <native-directory>");
prepareMacosLibraries(resolve(directory));
