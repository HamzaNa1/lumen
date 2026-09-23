import { existsSync } from "node:fs";
import { join } from "node:path";

const platform = process.platform;
const binary = platform === "win32" ? "mpv.exe" : "mpv";
const candidates = [
  join(process.cwd(), "apps", "desktop", "resources", "native", binary),
  join(process.cwd(), "resources", "native", binary),
];
const found = candidates.find(existsSync);
if (found === undefined) {
  throw new Error(`Packaged MPV binary is missing: ${candidates.join(", ")}`);
}
console.log(found);
