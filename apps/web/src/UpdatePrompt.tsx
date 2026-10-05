import type { ServerApi } from "@lumen/client";
import { UpdateToast } from "@lumen/ui";
import { useEffect, useState } from "react";

/**
 * Offers a reload when this page no longer matches the server. After an upgrade the server only
 * has the new build's files, so a page loaded before it would fail to fetch its old ones.
 */
export const UpdatePrompt = ({ api }: { readonly api: ServerApi }): React.ReactElement | null => {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    // Vite raises this when a script or style from this build can no longer be loaded.
    const onPreloadError = (event: Event): void => {
      event.preventDefault();
      setStale(true);
    };
    const checkVersion = (): void => {
      if (document.visibilityState !== "visible") return;
      void api
        .identity()
        .then((identity) => {
          if (
            identity.serverVersion !== undefined &&
            identity.serverVersion !== __LUMEN_SERVER_VERSION__
          )
            setStale(true);
        })
        .catch(() => undefined);
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    document.addEventListener("visibilitychange", checkVersion);
    checkVersion();
    return () => {
      window.removeEventListener("vite:preloadError", onPreloadError);
      document.removeEventListener("visibilitychange", checkVersion);
    };
  }, [api]);

  if (!stale) return null;
  return (
    <UpdateToast
      message="Lumen was updated. Reload to keep using it."
      action="Reload"
      onAction={() => window.location.reload()}
    />
  );
};
