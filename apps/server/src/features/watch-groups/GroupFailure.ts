import type { GroupErrorCode } from "@lumen/contracts";
import { ServerError } from "../../core/Errors";
export class GroupFailure extends ServerError {
  constructor(
    readonly groupCode: GroupErrorCode,
    message: string,
  ) {
    super({
      status:
        groupCode === "denied"
          ? 403
          : groupCode === "membership_expired"
            ? 404
            : groupCode === "invalid_command"
              ? 400
              : groupCode === "capacity" || groupCode === "rate_limited"
                ? 429
                : 409,
      code: "conflict",
      message,
    });
  }
}
