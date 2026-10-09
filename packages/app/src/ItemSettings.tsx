import { Button, Modal } from "@lumen/ui";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import { EpisodeOrder } from "./EpisodeOrder";
import { MetadataMatch } from "./MetadataMatch";
import { useMetadataRefresh } from "./useMetadataRefresh";

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
  const [open, setOpen] = useState(false);
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
        className="item-settings-dialog"
      >
        <div className="dialog-form">
          {metadataProviderConfigured ? (
            <>
              <MetadataMatch
                itemId={itemId}
                title={title}
                busy={refresh === "running"}
                onSaved={setRunId}
              />
              {kind === "show" ? (
                <EpisodeOrder itemId={itemId} busy={refresh === "running"} onSaved={setRunId} />
              ) : null}
            </>
          ) : (
            <p className="field-description">
              {kind === "show" ? "Matches and episode orders" : "Matches"} come from TMDb. Add a
              TMDb API key under Administration → Libraries to choose one.
            </p>
          )}
          {refresh === "running" ? <p role="status">Saved. Refreshing details from TMDb…</p> : null}
          {refresh === "succeeded" ? <p role="status">Details refreshed.</p> : null}
          {refresh === "failed" ? (
            <p className="form-error" role="alert">
              Saved, but the refresh could not finish. Check the Job log for details.
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};
