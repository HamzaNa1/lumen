import { randomId } from "@lumen/client";

const STORAGE_KEY = "lumen.devices";

/**
 * A stable device ID for one account on one server, so signing in again from this browser
 * updates its existing device instead of adding another. The server ties a device to a single
 * account, hence one ID per account. It is an identifier, not a credential.
 */
export const deviceIdFor = (serverId: string, username: string): string => {
  const key = `${serverId}\n${username.trim().toLowerCase()}`;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const existing = stored[key];
    if (typeof existing === "string") return existing;
    const created = randomId();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, [key]: created }));
    return created;
  } catch {
    // Storage is unavailable (private browsing, blocked site data): this sign-in gets its own.
    return randomId();
  }
};
