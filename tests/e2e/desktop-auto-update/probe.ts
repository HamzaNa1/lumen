import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { extractFile } from "@electron/asar";

const [mode, asarPath, identityPath, snapshotPath, expectedVersion] = process.argv.slice(2);
if (!asarPath || !identityPath || !snapshotPath || (mode !== "snapshot" && mode !== "verify")) {
  throw new Error("Usage: probe.ts <snapshot|verify> <app.asar> <installation.json> <snapshot.json> [expected-version]");
}
const packageInfo = JSON.parse(extractFile(asarPath, "package.json").toString("utf8")) as { version: string };
const identityHash = createHash("sha256").update(readFileSync(identityPath)).digest("hex");
if (mode === "snapshot") {
  writeFileSync(snapshotPath, JSON.stringify({ version: packageInfo.version, identityHash }));
  console.log(`Recorded installed version ${packageInfo.version}`);
} else {
  const before = JSON.parse(readFileSync(snapshotPath, "utf8")) as { version: string; identityHash: string };
  if (!expectedVersion || packageInfo.version !== expectedVersion || before.version === expectedVersion) {
    throw new Error(`Expected a change from ${before.version} to ${expectedVersion}; found ${packageInfo.version}`);
  }
  if (identityHash !== before.identityHash) throw new Error("Installation identity changed during update");
  console.log(`Verified ${before.version} -> ${packageInfo.version}; installation identity retained`);
}
