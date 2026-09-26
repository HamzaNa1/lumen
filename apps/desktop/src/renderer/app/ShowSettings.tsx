import { Button, Modal, SelectField } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./format";
import { bridge, useWorkspace } from "./Workspace";

const defaultOrder = "default";

/** Settings button for a show's page, and the dialog it opens. */
export const ShowSettings = ({
  itemId,
  title,
  metadataProviderConfigured,
}: {
  readonly itemId: string;
  readonly title: string;
  readonly metadataProviderConfigured: boolean;
}): React.ReactElement => {
  const { scope } = useWorkspace();
  const client = useQueryClient();
  const refreshedRun = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const order = useQuery({
    queryKey: [...scope, "episode-order", itemId],
    queryFn: () => bridge.library.episodeOrder(itemId),
    enabled: open && metadataProviderConfigured,
  });
  const save = useMutation({
    mutationFn: async () => {
      if (order.data === undefined) throw new Error("Episode orders have not loaded");
      const groupId = chosen ?? order.data.groupId ?? defaultOrder;
      return bridge.library.setEpisodeOrder(itemId, {
        tmdbSeriesId: order.data.tmdbSeriesId,
        groupId: groupId === defaultOrder ? null : groupId,
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: [...scope, "episode-order", itemId] });
    },
  });
  // The refresh keeps running, and the page updates when it finishes, after the dialog closes.
  const refresh = useQuery({
    queryKey: [...scope, "episode-order-refresh", save.data?.runId],
    queryFn: () => bridge.admin.scanStatus(save.data?.runId ?? ""),
    enabled: save.data !== undefined,
    refetchInterval: (query) =>
      query.state.data === undefined || ["queued", "running"].includes(query.state.data.status)
        ? 1_000
        : false,
  });
  const status = refresh.data?.status;
  const refreshing =
    save.data !== undefined &&
    (status === undefined || status === "queued" || status === "running") &&
    !refresh.isError;
  useEffect(() => {
    if (status === undefined || status === "queued" || status === "running") return;
    if (save.data === undefined || refreshedRun.current === save.data.runId) return;
    refreshedRun.current = save.data.runId;
    void client.invalidateQueries({ queryKey: scope });
  }, [client, scope, status, save.data]);

  const value = chosen ?? order.data?.groupId ?? defaultOrder;
  const groups = order.data?.groups ?? [];
  const unavailable = value !== defaultOrder && !groups.some((group) => group.id === value);
  const selected = groups.find((group) => group.id === value);
  const error = order.error ?? save.error;
  return (
    <>
      <Button
        className="details-icon-button"
        size="lg"
        aria-label="Show settings"
        title="Show settings"
        onClick={() => setOpen(true)}
      >
        <Settings2 aria-hidden="true" size={17} />
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Show settings"
        description={title}
        className="show-settings-dialog"
      >
        <div className="dialog-form">
          <section className="show-settings-section" aria-labelledby="episode-order-heading">
            <div>
              <h3 id="episode-order-heading">Episode order</h3>
              <p>
                Choose the order that matches your season folders. Your files and episode numbers
                stay the same.
              </p>
            </div>
            {!metadataProviderConfigured ? (
              <p className="field-description">
                Episode orders come from TMDb. Add a TMDb API key under Administration → Libraries
                to choose one.
              </p>
            ) : order.isPending ? (
              <p role="status">Loading episode orders…</p>
            ) : order.data === undefined ? null : (
              <div className="show-settings-field">
                <SelectField
                  label="Episode order"
                  hideLabel
                  value={value}
                  disabled={save.isPending || refreshing}
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
          </section>
          {error === null ? null : (
            <p className="form-error" role="alert">
              {errorMessage(error, "Could not load or save episode orders")}
            </p>
          )}
          {refreshing ? <p role="status">Order saved. Refreshing episode titles…</p> : null}
          {status === "succeeded" ? <p role="status">Episode titles refreshed.</p> : null}
          {status === "failed" || status === "cancelled" || refresh.isError ? (
            <p className="form-error" role="alert">
              Order saved, but the refresh could not finish. Check the Job log for details.
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            {order.isError ? <Button onClick={() => void order.refetch()}>Retry</Button> : null}
            {metadataProviderConfigured ? (
              <Button
                variant="primary"
                disabled={
                  order.data === undefined ||
                  order.isError ||
                  unavailable ||
                  save.isPending ||
                  refreshing
                }
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : refreshing ? "Refreshing…" : "Save and refresh"}
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>
    </>
  );
};
