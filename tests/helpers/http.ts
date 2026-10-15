import { Schema } from "../../packages/contracts/node_modules/effect/dist/index.js";

export const responseJson = async <S extends Schema.Decoder<unknown, never>>(
  schema: S,
  response: Pick<Response, "json"> | Promise<Pick<Response, "json">>,
): Promise<S["Type"]> =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "preserve" })(await (await response).json());
