import type { AppUpdatesRuntime } from "@lumen/client/runtime";
import type { AppUpdateStatus } from "@lumen/contracts";
import { SwitchField, UpdateButton } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const APP_UPDATES_KEY = ["app-updates"] as const;

const useAppUpdateStatus = (updates: AppUpdatesRuntime) => {
  const queryClient = useQueryClient();
  useEffect(
    () => updates.onChange((status) => queryClient.setQueryData(APP_UPDATES_KEY, status)),
    [updates, queryClient],
  );
  return useQuery({ queryKey: APP_UPDATES_KEY, queryFn: updates.status, staleTime: Infinity });
};

/** A newer version of the app, beside the brand until the viewer installs it. */
export const AppUpdateButton = ({
  updates,
}: {
  readonly updates: AppUpdatesRuntime;
}): React.ReactElement | null => {
  const status = useAppUpdateStatus(updates);
  // Opening the release page cannot be followed further, so the click itself marks it under way.
  const [opened, setOpened] = useState<string | null>(null);
  const update = status.data?.update ?? null;
  if (update === null) return null;
  const { version } = update;
  if (update.phase === "ready")
    return (
      <UpdateButton
        state="ready"
        progress={1}
        label={`Restart to update to Lumen ${version}`}
        onClick={() => void updates.install().catch(() => undefined)}
      />
    );
  if (update.phase === "downloading")
    return (
      <UpdateButton
        state="active"
        progress={update.progress}
        label={`Downloading Lumen ${version}, ${Math.round(update.progress * 100)}%`}
        onClick={() => undefined}
      />
    );
  const page = status.data?.automatic === null;
  return (
    <UpdateButton
      state={page && opened === version ? "active" : "available"}
      progress={page && opened === version ? 1 : 0}
      label={page ? `Download Lumen ${version} from its release page` : `Download Lumen ${version}`}
      onClick={() => {
        if (page) setOpened(version);
        // A failed download returns the update to available, which the button shows.
        void updates.download().catch(() => undefined);
      }}
    />
  );
};

/** Whether updates download on their own, where the app can install them itself. */
export const AppUpdateSettings = ({
  updates,
}: {
  readonly updates: AppUpdatesRuntime;
}): React.ReactElement | null => {
  const queryClient = useQueryClient();
  const status = useAppUpdateStatus(updates);
  const setAutomatic = useMutation({
    mutationFn: (automatic: boolean) => updates.setAutomatic(automatic),
    onMutate: (automatic) =>
      queryClient.setQueryData<AppUpdateStatus>(APP_UPDATES_KEY, (current) =>
        current === undefined ? current : { ...current, automatic },
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: APP_UPDATES_KEY }),
  });
  const automatic = status.data?.automatic ?? null;
  if (automatic === null) return null;
  return (
    <section className="settings-group" aria-labelledby="settings-updates">
      <h2 id="settings-updates">Updates</h2>
      <div className="settings-card">
        <div className="settings-row">
          <SwitchField
            label="Update automatically"
            description="New versions download in the background and install the next time Lumen starts."
            checked={automatic}
            onCheckedChange={(checked) => setAutomatic.mutate(checked)}
          />
        </div>
      </div>
    </section>
  );
};
