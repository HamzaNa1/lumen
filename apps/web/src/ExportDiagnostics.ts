/** Clipboard access is unavailable on many plain HTTP home-network origins. */
export const exportPlaybackDiagnostics = async (text: string): Promise<void> => {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // A denied clipboard still leaves the user able to save the diagnostic report.
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = "lumen-playback-diagnostics.json";
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};
