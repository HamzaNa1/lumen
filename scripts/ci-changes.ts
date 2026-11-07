import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { affectedChecks, allChecks } from "./lib/ci-changes";

let checks = { ...allChecks };
if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  try {
    const base = process.env.CI_BASE_SHA;
    const head = process.env.CI_HEAD_SHA;
    if (![base, head].every((sha) => sha && /^[a-f0-9]{40}$/.test(sha)))
      throw new Error("Missing or invalid pull request revisions");
    const files = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    checks = affectedChecks(process.cwd(), files);
  } catch (error) {
    console.warn("Could not determine affected jobs; running all checks.", error);
  }
}
const output = Object.entries(checks)
  .map(([key, value]) => `${key}=${value}\n`)
  .join("");
console.log(output);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
