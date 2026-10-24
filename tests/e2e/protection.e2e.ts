import { chmodSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { bunExecutable, expect, test } from "./support/cli";

for (const mode of ["plan", "apply", "check"] as const)
  test(`main protection ${mode} respects persisted remote state and unrelated rules`, async ({
    workspace,
  }) => {
    const state = {
      name: "Main Protection",
      target: "branch",
      enforcement: "disabled",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [],
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_signatures" }],
    };
    workspace.write("ruleset.json", state);
    workspace.write(
      "bin/gh",
      `#!${bunExecutable()}
const path = process.env.RULESET_STATE;
if (!process.argv.includes("repos/HamzaNa1/lumen/rulesets/24072516")) process.exit(2);
if (process.argv.includes("PUT")) {
  if (process.env.READ_ONLY === "1") process.exit(1);
  const next = JSON.parse(await Bun.stdin.text());
  if (process.env.DROP_RULE === "1") next.rules = next.rules.filter(rule => rule.type !== "required_signatures");
  if (process.env.IGNORE_WRITE !== "1") await Bun.write(path, JSON.stringify(next));
}
console.log(await Bun.file(path).text());
`,
    );
    chmodSync(join(workspace.root, "bin/gh"), 0o755);
    const env = {
      PATH: `${join(workspace.root, "bin")}${delimiter}${process.env.PATH}`,
      RULESET_STATE: join(workspace.root, "ruleset.json"),
    };
    const result = workspace.script("main-protection", [mode], env);
    expect(result.status).toBe(mode === "check" ? 1 : 0);
    const stored = JSON.parse(readFileSync(env.RULESET_STATE, "utf8"));
    if (mode === "apply") {
      expect(stored).toMatchObject({ enforcement: "active", bypass_actors: [] });
      expect(stored.rules).toContainEqual({ type: "required_signatures" });
      expect(workspace.script("main-protection", ["check"], env).status).toBe(0);
      expect(
        workspace.script("main-protection", ["apply"], { ...env, READ_ONLY: "1" }).status,
      ).toBe(0);
    } else expect(stored).toEqual(state);
    for (const fault of ["READ_ONLY", "IGNORE_WRITE", "DROP_RULE"]) {
      workspace.write("ruleset.json", state);
      expect(
        workspace.script("main-protection", ["apply"], { ...env, [fault]: "1" }).status,
      ).not.toBe(0);
    }
    for (const changed of [
      { ...state, conditions: { ref_name: { include: ["refs/heads/other"], exclude: [] } } },
      { ...state, bypass_actors: undefined },
    ]) {
      workspace.write("ruleset.json", changed);
      expect(workspace.script("main-protection", ["apply"], env).status).not.toBe(0);
      expect(JSON.parse(readFileSync(env.RULESET_STATE, "utf8"))).toEqual(
        JSON.parse(JSON.stringify(changed)),
      );
    }
  });
