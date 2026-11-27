import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repository } from "./server";

interface JsonSchema {
  readonly $ref?: string;
  readonly allOf?: ReadonlyArray<JsonSchema>;
  readonly oneOf?: ReadonlyArray<JsonSchema>;
  readonly type?: string;
  readonly format?: string;
  readonly enum?: ReadonlyArray<unknown>;
  readonly nullable?: boolean;
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties?: JsonSchema | boolean;
}

interface Document {
  readonly paths: Record<
    string,
    Record<
      string,
      { responses: { "200": { content: { "application/json": { schema: JsonSchema } } } } }
    >
  >;
  readonly components: { readonly schemas: Record<string, JsonSchema> };
}

/** The Jellyfin release Lumen claims to be. */
const VERSION = "12.4.0";

// Read on first use, so discovering the suites needs no fixtures.
let loaded: Document | undefined;
const pinned = (): Document => {
  loaded ??= JSON.parse(
    readFileSync(join(repository, `tests/fixtures/jellyfin-openapi-${VERSION}.json`), "utf8"),
  ) as Document;
  return loaded;
};

const resolve = (document: Document, ref: string): JsonSchema => {
  const schema = document.components.schemas[ref.split("/").at(-1) ?? ""];
  if (schema === undefined) throw new Error(`Unknown schema ${ref}`);
  return schema;
};

/**
 * How a value departs from a schema, read the way Jellyfin's Kotlin and Swift SDKs read it: a field
 * the document does not mark nullable must be present and not null, or decoding fails.
 */
const problems = (document: Document, schema: JsonSchema, value: unknown, at: string): string[] => {
  if (schema.$ref !== undefined)
    return problems(document, resolve(document, schema.$ref), value, at);
  if (value === null || value === undefined)
    return schema.nullable === true ? [] : [`${at} is missing`];
  if (schema.allOf !== undefined)
    return schema.allOf.flatMap((part) => problems(document, part, value, at));
  if (schema.oneOf !== undefined)
    return schema.oneOf.some((part) => problems(document, part, value, at).length === 0)
      ? []
      : [`${at} matches none of its variants`];
  if (schema.enum !== undefined && !schema.enum.includes(value))
    return [`${at} is ${JSON.stringify(value)}, not one of ${schema.enum.join(", ")}`];
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return [`${at} is not a string`];
      if (
        schema.format === "uuid" &&
        !/^[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}$/iu.test(value)
      )
        return [`${at} is not a GUID`];
      if (schema.format === "date-time" && Number.isNaN(Date.parse(value)))
        return [`${at} is not a date`];
      return [];
    case "integer":
      return Number.isInteger(value) ? [] : [`${at} is not an integer`];
    case "number":
      return typeof value === "number" ? [] : [`${at} is not a number`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at} is not a boolean`];
    case "array":
      return Array.isArray(value)
        ? value.flatMap((entry, index) =>
            schema.items === undefined
              ? []
              : problems(document, schema.items, entry, `${at}[${index}]`),
          )
        : [`${at} is not an array`];
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return [`${at} is not an object`];
      const fields = value as Record<string, unknown>;
      const declared = Object.entries(schema.properties ?? {}).flatMap(([name, property]) =>
        problems(document, property, fields[name], `${at}.${name}`),
      );
      const extra = schema.additionalProperties;
      return typeof extra === "object"
        ? [
            ...declared,
            ...Object.entries(fields).flatMap(([name, entry]) =>
              problems(document, extra, entry, `${at}.${name}`),
            ),
          ]
        : declared;
    }
    default:
      return [];
  }
};

/** What is wrong with a response body for one route of the pinned Jellyfin release. */
export const specProblems = (path: string, method: string, body: unknown): string[] => {
  const document = pinned();
  const operation = document.paths[path]?.[method.toLowerCase()];
  if (operation === undefined) throw new Error(`Jellyfin ${VERSION} has no ${method} ${path}`);
  return problems(
    document,
    operation.responses["200"].content["application/json"].schema,
    body,
    "body",
  );
};
