import { Schema } from "effect";

export const API_VERSION = "1.0.0";

export const ServerInfo = Schema.Struct({
  serverId: Schema.String.check(Schema.isMinLength(1)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  apiVersion: Schema.String,
  serverVersion: Schema.optional(Schema.String),
  setupRequired: Schema.optional(Schema.Boolean),
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
export type ServerInfo = Schema.Schema.Type<typeof ServerInfo>;
