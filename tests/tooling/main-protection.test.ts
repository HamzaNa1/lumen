import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../../scripts/main-protection.ts", import.meta.url));
const requiredContexts = [
  "check",
  "browser",
  "server-image",
  "native-desktop / macOS lifecycle and MPV audio",
  "native-desktop / Windows Electron and MPV playback",
];
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lumen-main-protection-"));
  directories.push(root);
  const statePath = join(root, "ruleset.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      id: 24072516,
      name: "Main Protection",
      target: "branch",
      enforcement: "disabled",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [],
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_signatures" }],
    }),
  );
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const args = process.argv.slice(2);
const file = Bun.file(process.env.RULESET_STATE);
if (!args.includes("repos/HamzaNa1/lumen/rulesets/24072516")) process.exit(2);
if (args.includes("PUT")) {
  if (process.env.RULESET_READ_ONLY === "1") {
    console.error("HTTP 403: ruleset is read-only");
    process.exit(1);
  }
  const state = JSON.parse(await Bun.stdin.text());
  if (process.env.RULESET_DROP_RULE === "1") state.rules = state.rules.filter(rule => rule.type !== "required_signatures");
  if (process.env.RULESET_STALE === "1") {
    console.log(JSON.stringify(state));
    process.exit(0);
  }
  await Bun.write(file, JSON.stringify(state));
}
console.log(await file.text());
`,
  );
  chmodSync(gh, 0o755);
  const run = async (mode: string, env: Record<string, string | undefined> = {}) => {
    const child = Bun.spawn([process.execPath, command, mode], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RULESET_STATE: statePath,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
  const read = () => JSON.parse(readFileSync(statePath, "utf8"));
  const write = (state: unknown) => writeFileSync(statePath, JSON.stringify(state));
  return { run, read, write };
};

test("plan previews strict main checks without changing GitHub or dropping unrelated protections", async () => {
  const { run, read } = fixture();
  const before = read();
  const result = await run("plan");
  expect(result.exitCode, result.stderr).toBe(0);
  const plan = JSON.parse(result.stdout);
  expect(plan.enforcement).toBe("active");
  expect(plan.bypass_actors).toEqual([]);
  expect(plan.rules).toEqual(
    expect.arrayContaining([
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_signatures" },
      expect.objectContaining({ type: "pull_request" }),
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: "check", integration_id: 15368 },
            { context: "browser", integration_id: 15368 },
            { context: "server-image", integration_id: 15368 },
            {
              context: "native-desktop / macOS lifecycle and MPV audio",
              integration_id: 15368,
            },
            {
              context: "native-desktop / Windows Electron and MPV playback",
              integration_id: 15368,
            },
          ],
        },
      },
    ]),
  );
  expect(read()).toEqual(before);
});

test("apply activates strict checks while preserving stronger rules, and is a no-op once verified", async () => {
  const { run, read, write } = fixture();
  const state = read();
  state.rules.push(
    {
      type: "pull_request",
      parameters: { required_approving_review_count: 2, require_code_owner_review: true },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: [{ context: "security", integration_id: 42 }, { context: "check" }],
      },
    },
  );
  write(state);
  const applied = await run("apply");
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(applied.stdout).toContain("Verified");
  for (const context of requiredContexts) expect(applied.stdout).toContain(context);
  const verified = await run("check");
  expect(verified.exitCode, verified.stderr).toBe(0);
  const after = read();
  expect(after.enforcement).toBe("active");
  expect(after.rules).toEqual(
    expect.arrayContaining([
      { type: "required_signatures" },
      expect.objectContaining({
        type: "pull_request",
        parameters: expect.objectContaining({
          required_approving_review_count: 2,
          require_code_owner_review: true,
        }),
      }),
      expect.objectContaining({
        type: "required_status_checks",
        parameters: expect.objectContaining({
          required_status_checks: expect.arrayContaining([
            { context: "security", integration_id: 42 },
          ]),
        }),
      }),
    ]),
  );
  const again = await run("apply", { RULESET_READ_ONLY: "1" });
  expect(again.exitCode, again.stderr).toBe(0);
  expect(read()).toEqual(after);
});

test("apply fails verification if GitHub did not preserve an unrelated protection", async () => {
  const { run } = fixture();
  const result = await run("apply", { RULESET_DROP_RULE: "1" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("did not retain");
  expect(result.stdout).not.toContain("Verified");
});

test("check rejects disabled, incomplete, loose, spoofable, or bypassable protection without updating it", async () => {
  const { run, read, write } = fixture();
  const disabled = read();
  const plan = await run("plan");
  expect(plan.exitCode, plan.stderr).toBe(0);
  const desired = JSON.parse(plan.stdout);
  const scenarios = [
    disabled,
    {
      ...desired,
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    },
    {
      ...desired,
      rules: desired.rules.filter((rule: { type: string }) => rule.type !== "pull_request"),
    },
  ];
  for (const context of requiredContexts) {
    const state = structuredClone(desired);
    const checks = state.rules.find(
      (rule: { type: string }) => rule.type === "required_status_checks",
    ).parameters;
    checks.required_status_checks = checks.required_status_checks.filter(
      (check: { context: string }) => check.context !== context,
    );
    scenarios.push(state);
    for (const integration_id of [undefined, null, 42]) {
      const spoofable = structuredClone(desired);
      const parameters = spoofable.rules.find(
        (rule: { type: string }) => rule.type === "required_status_checks",
      ).parameters;
      parameters.required_status_checks.find(
        (check: { context: string }) => check.context === context,
      ).integration_id = integration_id;
      scenarios.push(spoofable);
    }
  }
  for (const weakParameter of [
    { strict_required_status_checks_policy: false },
    { do_not_enforce_on_create: true },
    {
      required_status_checks: [
        { context: "check", integration_id: 42 },
        { context: "browser" },
        { context: "server-image" },
      ],
    },
  ]) {
    const state = structuredClone(desired);
    Object.assign(
      state.rules.find((rule: { type: string }) => rule.type === "required_status_checks")
        .parameters,
      weakParameter,
    );
    scenarios.push(state);
  }
  for (const state of scenarios) {
    write(state);
    const result = await run("check");
    expect(result.exitCode, JSON.stringify(state)).not.toBe(0);
    expect(result.stderr).toContain("differs from policy");
    expect(result.stdout).not.toContain("Verified");
    expect(read()).toEqual(JSON.parse(JSON.stringify(state)));
  }
});

test("apply reports API permission failures and checks persisted state rather than trusting the update response", async () => {
  const { run, read } = fixture();
  const before = read();
  for (const env of [{ RULESET_READ_ONLY: "1" }, { RULESET_STALE: "1" }]) {
    const result = await run("apply", env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("Verified");
    expect(read()).toEqual(before);
  }
});

test("apply refuses to change another branch's scope or assume hidden bypass settings are empty", async () => {
  const { run, read, write } = fixture();
  const before = read();
  for (const state of [
    { ...before, conditions: { ref_name: { include: ["~ALL"], exclude: [] } } },
    { ...before, bypass_actors: undefined },
  ]) {
    write(state);
    const persisted = read();
    const result = await run("apply");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("Verified");
    expect(read()).toEqual(persisted);
  }
});
