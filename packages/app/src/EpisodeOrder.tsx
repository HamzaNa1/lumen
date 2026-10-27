import { Button } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "./format";
import { CurrentBadge, ItemSettingsPanel, SettingsChoice } from "./ItemSettingsPanel";
import { useRuntime } from "./Runtime";
import type { MetadataRefresh } from "./useMetadataRefresh";
import { useWorkspace } from "./Workspace";

const defaultOrder = "default";

/** Chooses which TMDb episode order a show's season folders follow. */
export const EpisodeOrder = ({
  itemId,
  hidden,
  refresh,
  onSaved,
}: {
  readonly itemId: string;
  readonly hidden: boolean;
  readonly refresh: MetadataRefresh;
  readonly onSaved: (runId: string) => void;
}): React.ReactElement => {
  const runtime = useRuntime();
  const { scope } = useWorkspace();
  const client = useQueryClient();
  const [chosen, setChosen] = useState<string>();
  const order = useQuery({
    queryKey: [...scope, "episode-order", itemId],
    queryFn: () => runtime.catalog.episodeOrder(itemId),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (order.data === undefined) throw new Error("Episode orders have not loaded");
      const groupId = chosen ?? order.data.groupId ?? defaultOrder;
      return runtime.catalog.setEpisodeOrder(itemId, {
        tmdbSeriesId: order.data.tmdbSeriesId,
        groupId: groupId === defaultOrder ? null : groupId,
      });
    },
    onSuccess: async ({ runId }) => {
      onSaved(runId);
      await client.invalidateQueries({ queryKey: [...scope, "episode-order", itemId] });
    },
  });

  const busy = save.isPending || refresh === "running";
  const saved = order.data === undefined ? undefined : (order.data.groupId ?? defaultOrder);
  const value = chosen ?? saved;
  const groups = order.data?.groups ?? [];
  const unavailable =
    saved !== undefined && saved !== defaultOrder && !groups.some((group) => group.id === saved);
  const choose = (next: string): void => {
    setChosen(next);
    save.reset();
  };
  const error = order.error ?? save.error;
  return (
    <ItemSettingsPanel
      label="Episode order"
      hidden={hidden}
      refresh={refresh}
      action={
        <>
          {order.isError ? <Button onClick={() => void order.refetch()}>Retry</Button> : null}
          <Button
            variant="primary"
            disabled={
              value === undefined || (unavailable && value === saved) || order.isError || busy
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save order"}
          </Button>
        </>
      }
    >
      <p className="item-settings-intro">
        Choose the order that matches your season folders. Your files and episode numbers stay the
        same.
      </p>
      {order.isPending ? (
        <p className="item-settings-note" role="status">
          Loading episode orders…
        </p>
      ) : order.data === undefined ? null : (
        <ul className="settings-choices" aria-label="Episode orders">
          <SettingsChoice
            selected={value === defaultOrder}
            disabled={busy}
            onSelect={() => choose(defaultOrder)}
          >
            <span className="settings-choice-title">
              Default order {saved === defaultOrder ? <CurrentBadge /> : null}
            </span>
            <span className="settings-choice-description">
              The season and episode numbers listed by TMDb.
            </span>
          </SettingsChoice>
          {groups.map((group) => (
            <SettingsChoice
              key={group.id}
              selected={value === group.id}
              disabled={busy}
              onSelect={() => choose(group.id)}
            >
              <span className="settings-choice-title">
                {group.name} {saved === group.id ? <CurrentBadge /> : null}
              </span>
              <span className="settings-choice-meta">{group.type}</span>
              {group.description === "" ? null : (
                <span className="settings-choice-description">{group.description}</span>
              )}
            </SettingsChoice>
          ))}
          {unavailable ? (
            <SettingsChoice selected={value === saved} disabled onSelect={() => undefined}>
              <span className="settings-choice-title">
                Saved order <CurrentBadge />
              </span>
              <span className="settings-choice-meta">Unavailable</span>
              <span className="settings-choice-description">
                TMDb no longer offers this order. Choose another before refreshing.
              </span>
            </SettingsChoice>
          ) : null}
        </ul>
      )}
      {order.data !== undefined && groups.length === 0 ? (
        <p className="item-settings-note">No alternate orders are available for this show.</p>
      ) : null}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {errorMessage(error, "Could not load or save episode orders")}
        </p>
      )}
    </ItemSettingsPanel>
  );
};
