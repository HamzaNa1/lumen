import {
  defaultHomePreferences,
  type HomePreferences,
  type HomeSectionType,
  type IpcLibrary,
} from "@lumen/contracts";
import { Button, CheckboxField, Form, StatusState, SwitchField, TextField } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge, useLibraries, useWorkspace } from "./Workspace";

const sectionLabels: Record<HomeSectionType, string> = {
  libraries: "My Media",
  "resume-video": "Continue watching",
  "resume-audio": "Continue listening",
  "next-up": "Next up",
  latest: "Latest media",
};

const move = <T,>(values: ReadonlyArray<T>, index: number, direction: -1 | 1): T[] => {
  const next = [...values];
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
};

const OrderButtons = ({
  label,
  index,
  count,
  onMove,
  disabled,
}: {
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly onMove: (direction: -1 | 1) => void;
  readonly disabled: boolean;
}) => (
  <div className="home-order-buttons">
    <Button
      variant="icon"
      size="sm"
      aria-label={`Move ${label} up`}
      disabled={disabled || index === 0}
      onClick={() => onMove(-1)}
    >
      <ArrowUp size={15} aria-hidden="true" />
    </Button>
    <Button
      variant="icon"
      size="sm"
      aria-label={`Move ${label} down`}
      disabled={disabled || index === count - 1}
      onClick={() => onMove(1)}
    >
      <ArrowDown size={15} aria-hidden="true" />
    </Button>
  </div>
);

const HomeSettingsEditor = ({
  initial,
  libraries,
}: {
  readonly initial: HomePreferences;
  readonly libraries: ReadonlyArray<IpcLibrary>;
}) => {
  const { scope } = useWorkspace();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [days, setDays] = useState(String(initial.nextUpDays));
  useEffect(() => {
    if (!dirty) {
      setDraft(initial);
      setDays(String(initial.nextUpDays));
    }
  }, [initial, dirty]);
  const update = (patch: Partial<HomePreferences>): void => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setDirty(true);
    setSaved(false);
  };
  const save = useMutation({
    mutationFn: (value: HomePreferences) => bridge.library.saveHomePreferences(value),
    onSuccess: (value) => {
      queryClient.setQueryData([...scope, "home-preferences"], value);
      void queryClient.invalidateQueries({ queryKey: [...scope, "home"] });
      setSaved(true);
      setDirty(false);
    },
  });
  const orderedLibraries = [...libraries].sort((a, b) => {
    const first = draft.libraryOrder.indexOf(a.id);
    const second = draft.libraryOrder.indexOf(b.id);
    return (
      (first < 0 ? Infinity : first) - (second < 0 ? Infinity : second) ||
      a.name.localeCompare(b.name)
    );
  });
  const allSections = [
    ...draft.sections,
    ...defaultHomePreferences.sections.filter((section) => !draft.sections.includes(section)),
  ];
  const toggleLibrary = (
    key: "hiddenLibraries" | "excludedLibraries",
    id: string,
    included: boolean,
  ): void =>
    update({ [key]: included ? draft[key].filter((value) => value !== id) : [...draft[key], id] });
  return (
    <Form
      className="home-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ ...draft, nextUpDays: Number(days) });
      }}
    >
      <fieldset disabled={save.isPending} className="home-settings-fields">
        <p className="settings-description">
          Choose and arrange the sections on Home. These settings are saved for your account on this
          server.
        </p>
        <div className="settings-card">
          {allSections.map((section) => {
            const index = draft.sections.indexOf(section);
            return (
              <div className="settings-row" key={section}>
                <CheckboxField
                  label={sectionLabels[section]}
                  checked={index >= 0}
                  disabled={save.isPending}
                  onCheckedChange={(checked) =>
                    update({
                      sections: checked
                        ? [...draft.sections, section]
                        : draft.sections.filter((value) => value !== section),
                    })
                  }
                />
                {index < 0 ? null : (
                  <OrderButtons
                    label={sectionLabels[section]}
                    index={index}
                    count={draft.sections.length}
                    disabled={save.isPending}
                    onMove={(direction) =>
                      update({ sections: move(draft.sections, index, direction) })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
        <SwitchField
          label="Hide watched videos from Latest"
          checked={draft.hideWatched}
          disabled={save.isPending}
          onCheckedChange={(hideWatched) => update({ hideWatched })}
        />
        <TextField
          label="Days to keep shows in Next up"
          type="number"
          min={1}
          max={36500}
          step={1}
          required
          value={days}
          description="Shows leave Next up after this many days without viewing activity."
          onValueChange={(value) => {
            setDays(value);
            setDirty(true);
            setSaved(false);
          }}
        />
        {orderedLibraries.length === 0 ? null : (
          <>
            <h3>Libraries</h3>
            <p className="settings-description">
              Library order applies to My Media and Latest. Turning off Latest also hides that
              library from Continue and Next up. Hiding My Media also hides its Latest row.
            </p>
            <div className="settings-card">
              {orderedLibraries.map((library, index) => (
                <div className="home-library-setting" key={library.id}>
                  <div className="home-library-setting-title">
                    <span>{library.name}</span>
                    <OrderButtons
                      label={library.name}
                      index={index}
                      count={orderedLibraries.length}
                      disabled={save.isPending}
                      onMove={(direction) =>
                        update({
                          libraryOrder: move(
                            orderedLibraries.map((value) => value.id),
                            index,
                            direction,
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="home-library-toggles">
                    <CheckboxField
                      label={`Show ${library.name} in My Media`}
                      checked={!draft.hiddenLibraries.includes(library.id)}
                      disabled={save.isPending}
                      onCheckedChange={(checked) =>
                        toggleLibrary("hiddenLibraries", library.id, checked)
                      }
                    />
                    <CheckboxField
                      label={`Include ${library.name} in Latest`}
                      checked={!draft.excludedLibraries.includes(library.id)}
                      disabled={save.isPending}
                      onCheckedChange={(checked) =>
                        toggleLibrary("excludedLibraries", library.id, checked)
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </fieldset>
      {save.isError ? (
        <p role="alert" className="home-settings-error">
          Couldn’t save your home settings. Try again.
        </p>
      ) : null}
      <div className="home-settings-actions">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save home settings"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={save.isPending}
          onClick={() => {
            setDraft(defaultHomePreferences);
            setDays("365");
            setDirty(true);
            setSaved(false);
          }}
        >
          Reset to defaults
        </Button>
        {saved ? <span role="status">Saved</span> : null}
      </div>
    </Form>
  );
};

export const HomeSettings = (): React.ReactElement => {
  const { scope } = useWorkspace();
  const settings = useQuery({
    queryKey: [...scope, "home-preferences"],
    queryFn: () => bridge.library.homePreferences(),
  });
  const libraries = useLibraries(scope);
  return (
    <section className="settings-group" aria-labelledby="settings-home">
      <h2 id="settings-home">Home</h2>
      {settings.isError || libraries.isError ? (
        <StatusState
          title="Couldn’t load home settings"
          action={
            <Button
              onClick={() => {
                void settings.refetch();
                void libraries.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : settings.data === undefined || libraries.data === undefined ? (
        <p role="status">Loading home settings…</p>
      ) : (
        <HomeSettingsEditor
          key={scope.join(":")}
          initial={settings.data}
          libraries={libraries.data}
        />
      )}
    </section>
  );
};
