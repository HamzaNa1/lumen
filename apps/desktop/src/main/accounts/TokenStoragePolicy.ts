interface SafeStorageAvailability {
  readonly isEncryptionAvailable: () => boolean;
  readonly getSelectedStorageBackend?: () => string;
}

export const canEncryptTokens = (storage: SafeStorageAvailability, platform: NodeJS.Platform): boolean => {
  if (!storage.isEncryptionAvailable()) return false;
  if (platform !== "linux") return true;
  return typeof storage.getSelectedStorageBackend === "function" && storage.getSelectedStorageBackend() !== "basic_text";
};
