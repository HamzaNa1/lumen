import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { releaseCertificate } from "./sign-macos.mjs";

// macOS reports a bundle it cannot verify as damaged once downloaded, and a release signed by any
// other certificate loses the Keychain and privacy permissions viewers granted earlier versions.
const app = join(import.meta.dirname, "..", "release", "mac-arm64", "Lumen.app");
const codesign = (...args: string[]): string => {
  const result = spawnSync("codesign", [...args, app], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`codesign ${args.join(" ")} failed: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
};

codesign("--verify", "--deep", "--strict");
const identifier = codesign("--display", "--verbose=1").match(/^Identifier=(.+)$/mu)?.[1];
if (identifier !== "dev.lumen.desktop")
  throw new Error(`Lumen.app is signed as ${identifier ?? "nothing"}, not dev.lumen.desktop`);
if (process.argv.includes("--release")) {
  const requirement = `designated => identifier "dev.lumen.desktop" and certificate root = H"${releaseCertificate.toLowerCase()}"`;
  const actual = codesign("--display", "--requirements", "-").match(/designated => .+$/mu)?.[0];
  if (actual !== requirement)
    throw new Error(
      `Lumen.app is not signed with the release certificate: ${actual ?? "unsigned"}`,
    );
}
console.log(`${app}: ${identifier}`);
