// A product is what gets released. Its workspaces are everything that ships in it, listed in the
// order they must build: shared packages first, then the apps that bundle them. The server
// release carries the web app, so the web app and the frontend packages belong to it too.
export const products = {
  server: {
    name: "Lumen Server",
    manifest: "apps/server/package.json",
    workspaces: [
      "packages/contracts",
      "packages/database",
      "packages/client",
      "packages/ui",
      "packages/app",
      "apps/web",
      "apps/server",
    ],
    tests: ["tests/server", "tests/web"],
  },
  desktop: {
    name: "Lumen Desktop",
    manifest: "apps/desktop/package.json",
    workspaces: [
      "packages/contracts",
      "packages/client",
      "packages/ui",
      "packages/app",
      "apps/desktop",
    ],
    tests: ["tests/desktop"],
  },
} as const;
export type Product = keyof typeof products;

export const parseProduct = (value: string | undefined): Product => {
  if (value !== "server" && value !== "desktop") throw new Error("Choose server or desktop.");
  return value;
};

export const productWorkspaces = (product: Product): string[] => [...products[product].workspaces];

export const checkWorkspaces = (product: Product): string[] => [
  ...productWorkspaces(product),
  "packages/testkit",
];

export const productTests = (product: Product): string[] => [
  ...products[product].tests,
  "tests/shared",
  "tests/tooling",
];

// These regressions need both products at runtime. CI exercises the source pair;
// releases substitute the latest stable counterpart, keeping its dependencies too.
export const compatibilitySuites = {
  "desktop-mpv-window-lifecycle.test.ts": ["desktop"],
  "server-watch-groups.test.ts": ["server"],
  "playback-bridge.test.ts": ["desktop", "server"],
  "watch-group-client.test.ts": ["desktop", "server"],
  "watch-playback.test.ts": ["desktop", "server"],
  "mixed-watch-groups.test.ts": ["desktop", "server"],
  "releases.test.ts": ["desktop", "server"],
} satisfies Record<string, Product[]>;

export const productCompatibilityTests = (product: Product): string[] =>
  Object.entries(compatibilitySuites)
    .filter(([, owners]) => owners.some((owner) => owner === product))
    .map(([file]) => `tests/compatibility/${file}`);

export const workspaceFilters = (paths: readonly string[]): string[] =>
  paths.flatMap((path) => ["--filter", `./${path}`]);
