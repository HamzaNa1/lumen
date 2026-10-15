import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { productCompatibilityTests } from "../../scripts/lib/products";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("release regression ownership includes shared watch behavior without coupling product internals", () => {
  const desktop = productCompatibilityTests("desktop");
  const server = productCompatibilityTests("server");
  for (const selected of [desktop, server]) {
    expect(selected).toContain("tests/compatibility/playback-bridge.test.ts");
    expect(selected).toContain("tests/compatibility/watch-group-client.test.ts");
    expect(selected).toContain("tests/compatibility/watch-playback.test.ts");
    expect(selected).toContain("tests/compatibility/mixed-watch-groups.test.ts");
    expect(selected).toContain("tests/compatibility/releases.test.ts");
  }
  expect(desktop).toContain("tests/compatibility/desktop-mpv-window-lifecycle.test.ts");
  expect(desktop).not.toContain("tests/compatibility/server-watch-groups.test.ts");
  expect(server).toContain("tests/compatibility/server-watch-groups.test.ts");
  expect(server).not.toContain("tests/compatibility/desktop-mpv-window-lifecycle.test.ts");
});

test("new compatibility and browser suites cannot silently escape product ownership", async () => {
  const { assertVerificationCoverage, browserSuites } = await import(
    "../../scripts/lib/verification"
  );
  const { compatibilitySuites } = await import("../../scripts/lib/products");
  const known = [
    ...Object.keys(compatibilitySuites).map((name) => `tests/compatibility/${name}`),
    ...Object.keys(browserSuites).map((name) => `tests/browser/${name}`),
  ];
  expect(() => assertVerificationCoverage(known)).not.toThrow();
  for (const path of [
    "tests/compatibility/new-regression.test.ts",
    "tests/browser/new-flow.e2e.ts",
  ])
    expect(() => assertVerificationCoverage([...known, path])).toThrow(path);
  expect(() =>
    assertVerificationCoverage(known.filter((path) => !path.endsWith("watch-playback.test.ts"))),
  ).toThrow("watch-playback.test.ts");
  const files = [
    ...new Bun.Glob(
      "tests/{compatibility,browser}/**/*.{test,spec,e2e}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
    ).scanSync({
      cwd: repository,
    }),
  ];
  expect(() => assertVerificationCoverage(files)).not.toThrow();
});

test.each(["server", "desktop"] as const)(
  "%s release regressions load candidate code and stable counterpart code, including fixture imports",
  async (product) => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createVerificationWorkspace } = await import(
      "../../scripts/lib/verification-workspace"
    );
    const root = mkdtempSync(join(tmpdir(), "lumen-verification-test-"));
    const candidate = join(root, "candidate");
    const released = join(root, "released");
    const counterpart = product === "server" ? "desktop" : "server";
    const write = (path: string, content: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    try {
      write(join(candidate, "package.json"), '{"type":"module"}');
      for (const tree of [candidate, released]) {
        for (const workspace of [
          "apps/server",
          "apps/desktop",
          "apps/web",
          "packages/database",
          "packages/client",
        ]) {
          write(join(tree, workspace, "package.json"), '{"type":"module"}');
          const broken =
            tree === candidate &&
            (workspace === `apps/${counterpart}` ||
              (product === "desktop" && ["apps/web", "packages/database"].includes(workspace)));
          write(
            join(tree, workspace, "index.ts"),
            broken
              ? 'throw new Error("Unreleased counterpart is broken");'
              : `export const version = "${tree === candidate ? "candidate" : "released"}";`,
          );
        }
      }
      write(
        join(candidate, "tests/helpers/fixture.ts"),
        'export { version } from "../../packages/database/index.ts";',
      );
      const regression = `
        import { test, expect } from "bun:test";
        import { version as own } from "../../apps/${product}/index.ts";
        import { version as other } from "../../apps/${counterpart}/index.ts";
        import { version as client } from "../../packages/client/index.ts";
        import { version as database } from "../helpers/fixture";
        test("versions", () => {
          expect(own).toBe("candidate"); expect(other).toBe("released");
          expect(client).toBe("candidate");
          expect(database).toBe("${product === "desktop" ? "released" : "candidate"}");
        });
      `;
      write(join(candidate, "tests/compatibility/regression.test.ts"), regression);
      const workspace = join(root, "verification");
      createVerificationWorkspace({ product, candidate, released, workspace });
      const run = () =>
        Bun.spawnSync([process.execPath, "test", "./tests/compatibility/regression.test.ts"], {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
      const healthy = run();
      expect(healthy.exitCode, healthy.stderr.toString()).toBe(0);
      write(
        join(candidate, `apps/${product}/index.ts`),
        'export const version = "candidate"; throw new Error("Candidate regression");',
      );
      const broken = run();
      expect(broken.exitCode).not.toBe(0);
      expect(broken.stderr.toString()).toContain("Candidate regression");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("releases gate packaging and publishing on same-commit product browser verification", async () => {
  const readWorkflow = async (name: string) =>
    Bun.YAML.parse(await Bun.file(`${repository}.github/workflows/${name}.yml`).text()) as {
      jobs: Record<
        string,
        {
          needs?: string | string[];
          uses?: string;
          if?: string;
          "continue-on-error"?: boolean;
          with?: Record<string, string>;
          steps?: {
            uses?: string;
            run?: string;
            if?: string;
            "continue-on-error"?: boolean;
            env?: Record<string, string>;
            with?: Record<string, string>;
          }[];
        }
      >;
    };
  const preflight = await readWorkflow("release-preflight");
  const browser = preflight.jobs.browser;
  expect(browser).toBeDefined();
  const dependencies = (needs: string | string[] | undefined): string[] =>
    typeof needs === "string" ? [needs] : (needs ?? []);
  expect(dependencies(browser?.needs)).toContain("check");
  expect(browser?.if).toBeUndefined();
  expect(browser?.["continue-on-error"]).toBeUndefined();
  const checkout = browser?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.ref).toBe(`\${{ github.sha }}`);
  const verify = browser?.steps?.find((step) => step.run?.includes("scripts/test-browser.ts"));
  expect(verify?.run).toBe('bun scripts/test-browser.ts "$RELEASE_PRODUCT"');
  expect(verify?.env?.RELEASE_PRODUCT).toBe(`\${{ inputs.product }}`);
  expect(verify?.if).toBeUndefined();
  expect(verify?.["continue-on-error"]).toBeUndefined();
  const regressions = preflight.jobs.check?.steps?.find((step) =>
    step.run?.includes("check-release-compatibility.ts"),
  );
  expect(regressions?.run).toContain('"$RELEASE_PRODUCT"');
  expect(regressions?.if).toBeUndefined();
  expect(regressions?.["continue-on-error"]).toBeUndefined();
  const upload = browser?.steps?.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.if).toBe("${{ !cancelled() }}");
  expect(upload?.with?.path).toContain("test-results/${{ inputs.product }}/");
  expect(upload?.with?.path).toContain("playwright-report/${{ inputs.product }}/");
  expect(upload?.with?.["if-no-files-found"]).toBe("error");
  for (const product of ["desktop", "server"]) {
    const release = await readWorkflow(`release-${product}`);
    expect(release.jobs.preflight?.uses).toBe("./.github/workflows/release-preflight.yml");
    expect(release.jobs.preflight?.with?.product).toBe(product);
    expect(
      dependencies(release.jobs[product === "desktop" ? "package" : "server-image"]?.needs),
    ).toContain("preflight");
    expect(release.jobs.publish?.needs).toContain("preflight");
    if (product === "desktop") {
      expect(release.jobs["native-desktop"]?.uses).toBe("./.github/workflows/native-desktop.yml");
      expect(dependencies(release.jobs.package?.needs)).toContain("native-desktop");
      expect(dependencies(release.jobs.publish?.needs)).toContain("native-desktop");
    }
  }
});

test("browser discovery selects only each product's regressions and all required engines", () => {
  const list = (product: string) => {
    const child = Bun.spawnSync(
      [process.execPath, "run", "playwright", "test", "--list", "--reporter=json"],
      {
        cwd: repository,
        env: { ...process.env, LUMEN_BROWSER_PRODUCT: product },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString()) as {
      config: { projects: { name: string }[] };
      suites: { title: string; specs: { title: string }[] }[];
    };
  };
  const desktop = list("desktop");
  expect(desktop.config.projects.map((project) => project.name)).toEqual(["chromium"]);
  expect(desktop.suites.map((suite) => suite.title)).toEqual(["desktop-renderer.e2e.ts"]);
  expect(desktop.suites.flatMap((suite) => suite.specs.map((spec) => spec.title))).toEqual(
    expect.arrayContaining([
      "desktop pages and account menus retain their baseline behavior",
      "the connection forms are drawn identically",
      "watch groups are drawn identically",
      "the desktop player controls are what they were before the extraction",
    ]),
  );
  const server = list("server");
  expect(server.config.projects.map((project) => project.name)).toEqual([
    "chromium",
    "firefox",
    "webkit",
  ]);
  expect(server.suites.map((suite) => suite.title).sort()).toEqual([
    "artwork-cache.e2e.ts",
    "web-app.e2e.ts",
  ]);
  const source = list("source");
  expect(source.suites.map((suite) => suite.title).sort()).toEqual([
    "artwork-cache.e2e.ts",
    "desktop-parity.e2e.ts",
    "desktop-renderer.e2e.ts",
    "web-app.e2e.ts",
  ]);
}, 15_000);

test("filesystem ownership discovery rejects alternative Bun test filenames", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { verifyTestOwnership, browserSuites } = await import("../../scripts/lib/verification");
  const { compatibilitySuites } = await import("../../scripts/lib/products");
  const root = mkdtempSync(join(tmpdir(), "lumen-ownership-test-"));
  const files = [
    ...Object.keys(compatibilitySuites).map((name) => `tests/compatibility/${name}`),
    ...Object.keys(browserSuites).map((name) => `tests/browser/${name}`),
  ];
  try {
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    expect(() => verifyTestOwnership(root)).not.toThrow();
    for (const file of [
      "regression.spec.ts",
      "regression.test.tsx",
      "regression_test.js",
      "regression_spec.jsx",
    ]) {
      const path = join(root, "tests/compatibility", file);
      writeFileSync(path, "");
      expect(() => verifyTestOwnership(root)).toThrow(file);
      rmSync(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser artifacts escape temporary release workspaces and remain separated by product", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "lumen-browser-artifacts-"));
  try {
    for (const product of ["source", "server", "desktop"]) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
        import config from "./playwright.config.ts";
        console.log(JSON.stringify(config));
      `,
        ],
        {
          cwd: repository,
          env: {
            ...process.env,
            LUMEN_BROWSER_PRODUCT: product,
            LUMEN_BROWSER_ARTIFACT_ROOT: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const config = JSON.parse(child.stdout.toString());
      expect(config.outputDir).toBe(join(root, "test-results", product));
      expect(config.reporter).toContainEqual([
        "html",
        {
          outputFolder: join(root, "playwright-report", product),
          open: "never",
        },
      ]);
      expect(config.reporter).toContainEqual([
        "json",
        { outputFile: join(root, "test-results", product, "results.json") },
      ]);
      expect(config.reporter).toContainEqual([
        "junit",
        { outputFile: join(root, "test-results", product, "junit.xml") },
      ]);
      expect(config.use.trace).toBe("retain-on-failure");
      expect(config.use.screenshot).toBe("only-on-failure");
      expect(
        config.webServer.map(
          (server: { env: { LUMEN_BROWSER_TEST_MEDIA: string } }) =>
            server.env.LUMEN_BROWSER_TEST_MEDIA,
        ),
      ).toEqual(product === "desktop" ? ["mp4"] : ["mp4", "webm"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
