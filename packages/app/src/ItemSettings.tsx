import { Button, EmptyState, Modal, SegmentedControl } from "@lumen/ui";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, Settings2 } from "lucide-react";
import { useState } from "react";
import { EpisodeOrder } from "./EpisodeOrder";
import { MetadataMatch } from "./MetadataMatch";
import { useMetadataRefresh } from "./useMetadataRefresh";

type SettingsTab = "match" | "episode-order";

/** Settings button for a movie's or show's page, and the dialog it opens. */
export const ItemSettings = ({
  itemId,
  kind,
  title,
  metadataProviderConfigured,
}: {
  readonly itemId: string;
  readonly kind: "movie" | "show";
  readonly title: string;
  readonly metadataProviderConfigured: boolean;
}): React.ReactElement => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("match");
  const [runId, setRunId] = useState<string>();
  // The refresh keeps running, and the page updates when it finishes, after the dialog closes.
  const refresh = useMetadataRefresh(runId);
  const label = kind === "show" ? "Show settings" : "Movie settings";
  return (
    <>
      <Button
        className="details-icon-button"
        size="lg"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <Settings2 aria-hidden="true" size={17} />
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={label}
        description={title}
        className={`item-settings-dialog${metadataProviderConfigured ? " is-configured" : ""}`}
      >
        {metadataProviderConfigured ? (
          <>
            {kind === "show" ? (
              <div className="item-settings-tabs">
                <SegmentedControl
                  label="Settings"
                  value={tab}
                  onValueChange={setTab}
                  options={[
                    { value: "match", label: "TMDb match" },
                    { value: "episode-order", label: "Episode order" },
                  ]}
                />
              </div>
            ) : null}
            <MetadataMatch
              itemId={itemId}
              title={title}
              hidden={tab !== "match"}
              refresh={refresh}
              onSaved={setRunId}
            />
            {kind === "show" ? (
              <EpisodeOrder
                itemId={itemId}
                hidden={tab !== "episode-order"}
                refresh={refresh}
                onSaved={setRunId}
              />
            ) : null}
          </>
        ) : (
          <EmptyState
            icon={KeyRound}
            title="TMDb is not set up"
            message={`${kind === "show" ? "Matches and episode orders" : "Matches"} come from TMDb. Add a TMDb API key in Libraries to choose them.`}
            action={
              <Button
                variant="primary"
                onClick={() => {
                  setOpen(false);
                  void navigate({ to: "/admin" });
                }}
              >
                Open Libraries
              </Button>
            }
          />
        )}
      </Modal>
    </>
  );
};
