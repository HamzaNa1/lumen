import type { MetadataMatchCandidate } from "@lumen/contracts";
import { Button, Form, TextField } from "@lumen/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "./format";
import { CurrentBadge, ItemSettingsPanel, SettingsChoice } from "./ItemSettingsPanel";
import { useRuntime } from "./Runtime";
import type { MetadataRefresh } from "./useMetadataRefresh";
import { useWorkspace } from "./Workspace";

const MatchOption = ({
  candidate,
  current,
  selected,
  disabled,
  onSelect,
}: {
  readonly candidate: MetadataMatchCandidate;
  readonly current: boolean;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}): React.ReactElement => (
  <SettingsChoice
    selected={selected}
    disabled={disabled}
    onSelect={onSelect}
    media={
      <span className="match-poster">
        {candidate.posterUrl === null ? (
          <Film aria-hidden="true" size={16} />
        ) : (
          <img src={candidate.posterUrl} alt="" draggable={false} />
        )}
      </span>
    }
  >
    <span className="settings-choice-title">
      {candidate.title}{" "}
      {candidate.year === null ? null : (
        <span className="settings-choice-muted">{candidate.year}</span>
      )}{" "}
      {current ? <CurrentBadge /> : null}
    </span>
    <span className="settings-choice-meta">TMDb {candidate.tmdbId}</span>
    {candidate.overview === "" ? null : (
      <span className="settings-choice-description">{candidate.overview}</span>
    )}
  </SettingsChoice>
);

/** Chooses which TMDb title a movie or show takes its details and artwork from. */
export const MetadataMatch = ({
  itemId,
  title,
  hidden,
  refresh,
  onSaved,
}: {
  readonly itemId: string;
  readonly title: string;
  readonly hidden: boolean;
  readonly refresh: MetadataRefresh;
  readonly onSaved: (runId: string) => void;
}): React.ReactElement => {
  const runtime = useRuntime();
  const { scope } = useWorkspace();
  const client = useQueryClient();
  const [text, setText] = useState(title);
  const [query, setQuery] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>();
  const options = useQuery({
    queryKey: [...scope, "match-options", itemId, query],
    queryFn: () => runtime.catalog.matchOptions(itemId, query),
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: (tmdbId: string) => runtime.catalog.setMatch(itemId, { tmdbId }),
    onSuccess: async ({ runId }) => {
      onSaved(runId);
      setChosen(undefined);
      await Promise.all(
        ["match-options", "episode-order"].map((key) =>
          client.invalidateQueries({ queryKey: [...scope, key, itemId] }),
        ),
      );
    },
  });

  const busy = save.isPending || refresh === "running";
  const current = options.data?.tmdbId ?? null;
  const selected = chosen ?? current;
  const candidates = options.data?.candidates ?? [];
  const error = options.error ?? save.error;
  return (
    <ItemSettingsPanel
      label="TMDb match"
      hidden={hidden}
      refresh={refresh}
      action={
        <Button
          variant="primary"
          disabled={chosen === undefined || chosen === current || busy}
          onClick={() => {
            if (chosen !== undefined) save.mutate(chosen);
          }}
        >
          {save.isPending ? "Saving…" : "Use this match"}
        </Button>
      }
    >
      <p className="item-settings-intro">
        Details and artwork come from the TMDb title you pick.{" "}
        {current === null
          ? "Nothing is matched yet."
          : candidates.some((candidate) => candidate.tmdbId === current)
            ? null
            : `Currently matched to TMDb ${current}.`}
      </p>
      <Form
        className="match-search"
        onSubmit={(event) => {
          event.preventDefault();
          setChosen(undefined);
          save.reset();
          const next = text.trim() || null;
          // Searching again for the same thing is a retry, which a state change alone would skip.
          if (next === query) void options.refetch();
          else setQuery(next);
        }}
      >
        <TextField
          label="Title or TMDb ID"
          hideLabel
          value={text}
          onValueChange={setText}
          placeholder="Search by title or TMDb ID"
          autoComplete="off"
          maxLength={200}
        />
        <Button type="submit" disabled={options.isFetching}>
          {options.isFetching ? "Searching…" : "Search"}
        </Button>
      </Form>
      {options.data === undefined ? (
        options.isPending ? (
          <p className="item-settings-note" role="status">
            Searching TMDb…
          </p>
        ) : null
      ) : candidates.length === 0 ? (
        <p className="item-settings-note">
          Nothing on TMDb matches “{options.data.query}”. Try another title, or enter the TMDb ID.
        </p>
      ) : (
        <ul className="settings-choices" aria-label="Possible matches">
          {candidates.map((candidate) => (
            <MatchOption
              key={candidate.tmdbId}
              candidate={candidate}
              current={candidate.tmdbId === current}
              selected={candidate.tmdbId === selected}
              disabled={busy}
              onSelect={() => {
                setChosen(candidate.tmdbId);
                save.reset();
              }}
            />
          ))}
        </ul>
      )}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {errorMessage(error, "Could not load or save the match")}
        </p>
      )}
    </ItemSettingsPanel>
  );
};
