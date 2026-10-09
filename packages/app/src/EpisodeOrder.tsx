import { Button, SelectField } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "./format";
import { useWorkspace } from "./Workspace";
import { useRuntime } from "./Runtime";

const defaultOrder = "default";

/** Chooses which TMDb episode order a show's season folders follow. */
export const EpisodeOrder = ({
  itemId,
  busy,
  onSaved,
}: {
  readonly itemId: string;
  /** A refresh is still applying the last change. */
  readonly busy: boolean;
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

  const value = chosen ?? order.data?.groupId ?? defaultOrder;
  const groups = order.data?.groups ?? [];
  const unavailable = value !== defaultOrder && !groups.some((group) => group.id === value);
  const selected = groups.find((group) => group.id === value);
  const error = order.error ?? save.error;
  return (
    <section className="item-settings-section" aria-labelledby="episode-order-heading">
      <div>
        <h3 id="episode-order-heading">Episode order</h3>
        <p>
          Choose the order that matches your season folders. Your files and episode numbers stay the
          same.
        </p>
      </div>
      {order.isPending ? (
        <p role="status">Loading episode orders…</p>
      ) : order.data === undefined ? null : (
        <div className="item-settings-field">
          <SelectField
            label="Episode order"
            hideLabel
            value={value}
            disabled={save.isPending || busy}
            options={[
              { value: defaultOrder, label: "Default order" },
              ...groups.map((group) => ({
                value: group.id,
                label: `${group.name} · ${group.type}`,
              })),
              ...(unavailable ? [{ value, label: "Saved order (unavailable)" }] : []),
            ]}
            onValueChange={(next) => {
              setChosen(next);
              save.reset();
            }}
          />
          <p className="field-description">
            {unavailable
              ? "This order is no longer available. Choose another order before refreshing."
              : selected?.description ||
                (groups.length === 0
                  ? "No alternate orders are available for this show."
                  : "Default uses the season and episode numbers listed by TMDb.")}
          </p>
        </div>
      )}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {errorMessage(error, "Could not load or save episode orders")}
        </p>
      )}
      <div className="item-settings-actions">
        {order.isError ? <Button onClick={() => void order.refetch()}>Retry</Button> : null}
        <Button
          variant="primary"
          disabled={
            order.data === undefined || order.isError || unavailable || save.isPending || busy
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save order"}
        </Button>
      </div>
    </section>
  );
};
