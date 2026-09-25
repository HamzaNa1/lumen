import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import YAML from "yaml";

const version = "1.2.3";
const fixtures = [
  "Lumen-Setup-1.2.3-x64.exe", "Lumen-Portable-1.2.3-x64.exe",
  "Lumen-1.2.3-arm64.dmg", "Lumen-1.2.3-arm64-mac.zip",
  "Lumen-1.2.3-x64.AppImage", "Lumen-1.2.3-amd64.deb",
  "Lumen-Setup-1.2.3-x64.exe.blockmap",
  "Lumen-1.2.3-arm64-mac.zip.blockmap",
] as const;

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lumen-release-test-"));
  for (const name of fixtures) writeFileSync(join(root, name), `contents of ${name}`);
  for (const [feedName, payload] of [
    ["latest.yml", fixtures[0]],
    ["latest-mac.yml", fixtures[3]],
    ["latest-linux.yml", fixtures[4]],
  ]) {
    const bytes = readFileSync(join(root, payload));
    writeFileSync(join(root, feedName), YAML.stringify({
      version, files: [{ url: payload, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") }],
    }));
  }
  return root;
};

const verify = (root: string) => Bun.spawnSync(["bun", "scripts/verify-update-artifacts.ts", root, "--version", version], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });

test("valid generated assets produce an exact publish inventory", () => {
  const root = fixture();
  try {
    const result = verify(root);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "files.txt"), "utf8").trim().split("\n")).toHaveLength(11);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a changed payload is rejected before upload", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, fixtures[0]), "changed bytes");
    expect(verify(root).exitCode).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest cannot reference an external or traversing payload", () => {
  const root = fixture();
  try {
    const path = join(root, "latest.yml");
    const feed = YAML.parse(readFileSync(path, "utf8"));
    feed.files[0].url = "../Lumen-Setup-1.2.3-x64.exe";
    writeFileSync(path, YAML.stringify(feed));
    expect(verify(root).exitCode).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing channel metadata and duplicate basenames are rejected", () => {
  const root = fixture();
  try {
    rmSync(join(root, "latest-linux.yml"));
    expect(verify(root).exitCode).not.toBe(0);
    const duplicate = join(root, "nested");
    mkdirSync(duplicate);
    writeFileSync(join(root, "latest-linux.yml"), "version: 1.2.3\nfiles: []\n");
    writeFileSync(join(duplicate, fixtures[0]), "duplicate");
    expect(verify(root).exitCode).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows metadata cannot select the portable executable", () => {
  const root = fixture();
  try {
    const path = join(root, "latest.yml");
    const bytes = readFileSync(join(root, fixtures[1]));
    writeFileSync(path, YAML.stringify({ version, files: [{
      url: fixtures[1], size: bytes.length,
      sha512: createHash("sha512").update(bytes).digest("base64"),
    }] }));
    expect(verify(root).exitCode).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
