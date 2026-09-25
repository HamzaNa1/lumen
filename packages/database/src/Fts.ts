export const buildFtsMatch = (query: string): string =>
  query
    .trim()
    .split(/\s+/u)
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" AND ");
