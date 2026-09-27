export const products = {
  server: { name: "Lumen Server", manifest: "apps/server/package.json", packages: ["database"] },
  desktop: { name: "Lumen Desktop", manifest: "apps/desktop/package.json", packages: ["ui"] },
} as const;
export type Product = keyof typeof products;

export const parseProduct = (value: string | undefined): Product => {
  if (value !== "server" && value !== "desktop") throw new Error("Choose server or desktop.");
  return value;
};

export const productWorkspaces = (product: Product): string[] => [
  `apps/${product}`,
  "packages/contracts",
  ...products[product].packages.map((name) => `packages/${name}`),
];

export const checkWorkspaces = (product: Product): string[] => [
  ...productWorkspaces(product),
  "packages/testkit",
];

export const workspaceFilters = (paths: readonly string[]): string[] =>
  paths.flatMap((path) => ["--filter", `./${path}`]);
