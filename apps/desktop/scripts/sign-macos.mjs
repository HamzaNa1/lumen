import { signAsync } from "@electron/osx-sign";

/**
 * SHA-1 of the self-signed "Lumen Desktop" certificate that releases are signed with. macOS ties
 * Keychain access and privacy permissions to it, so replacing it resets them for every viewer.
 */
export const releaseCertificate = "E224F9615F086023C01181DED35B6B8A73430D9C";

/**
 * electron-builder neither finds a certificate the system does not trust nor imports one into its
 * keychain correctly, so the release workflow loads it into LUMEN_MACOS_KEYCHAIN. Other builds
 * are signed ad hoc.
 */
export default (options) => {
  const keychain = process.env.LUMEN_MACOS_KEYCHAIN;
  return signAsync(
    keychain
      ? { ...options, keychain, identity: releaseCertificate }
      : { ...options, identity: "-" },
  );
};
