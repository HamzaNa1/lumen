import { describe, expect, test } from "bun:test";
import { canEncryptTokens } from "../../apps/desktop/src/main/accounts/TokenStoragePolicy";

describe("desktop token storage availability", () => {
  test("uses encryption on macOS when Electron has no Linux backend API", () => {
    expect(canEncryptTokens({ isEncryptionAvailable: () => true }, "darwin")).toBe(true);
  });

  test("uses private file storage when the Linux backend is unknown or basic text", () => {
    expect(canEncryptTokens({ isEncryptionAvailable: () => true }, "linux")).toBe(false);
    expect(canEncryptTokens({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" }, "linux")).toBe(false);
    expect(canEncryptTokens({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "kwallet" }, "linux")).toBe(true);
  });
});
