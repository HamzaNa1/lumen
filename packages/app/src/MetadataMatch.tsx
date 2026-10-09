import type { MetadataMatchCandidate } from "@lumen/contracts";
import { Button, Form, TextField } from "@lumen/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "./format";
import { useWorkspace } from "./Workspace";
import { useRuntime } from "./Runtime";

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
  <li>
    <button
      type="button"
      className="match-option"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="match-poster">
        {candidate.posterUrl === null ? (
          <Film aria-hidden="true" size={18} />
        ) : (
          <img src={candidate.posterUrl} alt="" draggable={false} />
        )}
      </span>
      <span className="match-text">
        <span className="match-title">
          {candidate.title}
          {candidate.year === null ? null : <span className="match-year">{candidate.year}</span>}
        </span>
        <span className="match-id">
          TMDb ID {candidate.tmdbId}
          {current ? <span className="match-current">Current match</span> : null}
        </span>
        {candidate.overview === "" ? null : (
          <span className="match-overview">{candidate.overview}</span>
        )}
      </span>
    </button>
  </li>
);

/** Chooses which TMDb title a movie or show takes its details and artwork from. */
export const MetadataMatch = ({
  itemId,
  title,
  busy,
  onSaved,
}: {
  readonly itemId: string;
  readonly title: string;
  /** A refresh is still applying the last change. */
  readonly busy: boolean;
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

  const current = options.data?.tmdbId ?? null;
  const candidates = options.data?.candidates ?? [];
  const error = options.error ?? save.error;
  return (
    <section className="item-settings-section" aria-labelledby="match-heading">
      <div>
        <h3 id="match-heading">TMDb match</h3>
        <p>
          Details and artwork come from the title you pick here.{" "}
          {current === null
            ? "Nothing is matched yet."
            : `Currently matched to TMDb ID ${current}.`}
        </p>
      </div>
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
          placeholder="Title or TMDb ID"
          autoComplete="off"
          maxLength={200}
        />
        <Button type="submit" disabled={options.isFetching}>
          {options.isFetching ? "Searching…" : "Search"}
        </Button>
      </Form>
      {options.data === undefined ? (
        options.isPending ? (
          <p role="status">Searching TMDb…</p>
        ) : null
      ) : candidates.length === 0 ? (
        <p className="field-description">
          Nothing on TMDb matches “{options.data.query}”. Try another title, or enter the TMDb ID.
        </p>
      ) : (
        <ul className="match-list" aria-label="Possible matches">
          {candidates.map((candidate) => (
            <MatchOption
              key={candidate.tmdbId}
              candidate={candidate}
              current={candidate.tmdbId === current}
              selected={candidate.tmdbId === chosen}
              disabled={save.isPending || busy}
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
      <div className="item-settings-actions">
        <Button
          variant="primary"
          disabled={chosen === undefined || chosen === current || save.isPending || busy}
          onClick={() => {
            if (chosen !== undefined) save.mutate(chosen);
          }}
        >
          {save.isPending ? "Saving…" : "Use this match"}
        </Button>
      </div>
    </section>
  );
};
