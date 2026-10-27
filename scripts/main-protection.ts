import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import policy from "../.github/rulesets/main.json";

type StatusCheck = { context: string; integration_id?: number | null };
type Rule = {
  type: string;
  parameters?: { required_status_checks?: StatusCheck[]; [key: string]: unknown };
};
type Ruleset = {
  name: string;
  target: string;
  enforcement: string;
  conditions: typeof policy.conditions;
  bypass_actors?: unknown[];
  rules: Rule[];
};

// Retire only the checks replaced by the aggregate checks.yml gate; retain unrelated checks.
const retiredChecks = new Set([
  "browser",
  "server-image",
  "native-desktop / macOS lifecycle and MPV audio",
  "native-desktop / Windows Electron and MPV playback",
  "product-verification (server)",
  "product-verification (desktop)",
]);
const endpoint = "repos/HamzaNa1/lumen/rulesets/24072516";
const api = (body?: Ruleset): Ruleset =>
  JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        ...(body ? ["--method", "PUT", "--input", "-"] : []),
      ],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
        input: body ? JSON.stringify(body) : undefined,
      },
    ),
  );

const editableRuleset = (current: Ruleset): Ruleset => ({
  name: current.name,
  target: current.target,
  enforcement: current.enforcement,
  conditions: current.conditions,
  ...(current.bypass_actors === undefined ? {} : { bypass_actors: current.bypass_actors }),
  rules: current.rules,
});

const desiredRuleset = (current: Ruleset): Ruleset => {
  if (current.target !== policy.target || !isDeepStrictEqual(current.conditions, policy.conditions))
    throw new Error(
      "Main Protection must target only refs/heads/main; refusing to change its scope.",
    );
  if (!Array.isArray(current.bypass_actors))
    throw new Error(
      "GitHub hid bypass_actors. Use an account with ruleset write access to verify protection.",
    );
  const rules = structuredClone(current.rules);
  for (const required of policy.rules as Rule[]) {
    const existing = rules.find((rule) => rule.type === required.type);
    if (!existing) {
      rules.push(required);
    } else if (required.type === "required_status_checks") {
      const checks = (existing.parameters?.required_status_checks ?? []).filter(
        (check) => !retiredChecks.has(check.context),
      );
      for (const check of required.parameters?.required_status_checks ?? []) {
        const index = checks.findIndex((entry) => entry.context === check.context);
        if (index === -1) checks.push(check);
        else checks[index] = { ...checks[index], ...check };
      }
      existing.parameters = {
        ...existing.parameters,
        ...required.parameters,
        required_status_checks: checks,
      };
    } else if (required.type === "pull_request") {
      existing.parameters = { ...required.parameters, ...existing.parameters };
    }
  }
  return { ...policy, name: current.name, rules };
};

const sortedChecks = (checks: StatusCheck[]) =>
  [...checks].sort((a, b) => a.context.localeCompare(b.context));
const retainsRule = (rules: Rule[], expected: Rule): boolean => {
  const actual = rules.find((rule) => rule.type === expected.type);
  if (!actual) return false;
  return Object.entries(expected.parameters ?? {}).every(([key, value]) => {
    if (key === "required_status_checks")
      return isDeepStrictEqual(
        sortedChecks(actual.parameters?.required_status_checks ?? []),
        sortedChecks(value as StatusCheck[]),
      );
    return isDeepStrictEqual(actual.parameters?.[key], value);
  });
};

const [command, ...extra] = process.argv.slice(2);
if (!["plan", "apply", "check"].includes(command ?? "") || extra.length !== 0)
  throw new Error("Usage: bun scripts/main-protection.ts <plan|apply|check>");
const current = editableRuleset(api());
const desired = desiredRuleset(current);
if (command === "plan") {
  console.log(JSON.stringify(desired, null, 2));
} else {
  if (command === "apply" && !isDeepStrictEqual(current, desired)) api(desired);
  const verified = editableRuleset(api());
  if (!isDeepStrictEqual(verified, desiredRuleset(verified)))
    throw new Error(
      "Main protection differs from policy. Inspect plan, then run apply with ruleset write access.",
    );
  if (
    verified.name !== desired.name ||
    !desired.rules.every((rule) => retainsRule(verified.rules, rule))
  )
    throw new Error(
      "GitHub did not retain the planned ruleset. Inspect live protection before retrying.",
    );
  console.log(
    `Verified ${endpoint}: active, no bypass, pull requests, strict required checks from GitHub Actions: ${policy.rules
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context)
      .join(", ")}.`,
  );
}
