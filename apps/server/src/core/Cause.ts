import { badRequest, internal, notFound, ServerError } from "./Errors";

export const mapRepositoryError = (cause: unknown): ServerError => {
  if (cause instanceof ServerError) return cause;
  const operation = typeof cause === "object" && cause !== null && "operation" in cause
    ? String(cause.operation)
    : "database";
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/unique|constraint|foreign key/i.test(text)) return badRequest(`Repository constraint failed: ${operation}`);
  return internal("Database operation failed", cause);
};

export const missing = (entity: string): never => {
  throw notFound(`${entity} not found`);
};
