import { UpdateToast } from "@lumen/ui";
import { useEffect, useState } from "react";
import type { DesktopBridge } from "../../shared/bridge";

/**
 * Offers a restart once a new version has been downloaded. Ignoring it is fine: the update is
 * installed anyway the next time the app quits.
 */
export const UpdateReady = ({
  updates,
}: {
  readonly updates: DesktopBridge["updates"];
}): React.ReactElement | null => {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = updates.onReady(setVersion);
    // The download may have finished before this window was listening.
    void updates
      .ready()
      .then((ready) => setVersion((current) => current ?? ready))
      .catch(() => undefined);
    return unsubscribe;
  }, [updates]);

  if (version === null) return null;
  return (
    <UpdateToast
      message={`Lumen ${version} is ready. Restart to update.`}
      action="Restart"
      onAction={() => void updates.install()}
    />
  );
};
