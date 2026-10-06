import type { TrackPreferencesPatch } from "@lumen/contracts";
import { Button, Form, Modal, TextField, SelectField } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { errorMessage, hostOf, roleLabels } from "./format";
import { useRuntime } from "./Runtime";
import { ACCOUNTS_KEY, PageHeader, useWorkspace } from "./Workspace";

const SettingsRow = ({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}): React.ReactElement => (
  <div className="settings-row">
    <div className="settings-row-text">
      <span>{label}</span>
      {description === undefined ? null : <p>{description}</p>}
    </div>
    <div className="settings-row-value">{children}</div>
  </div>
);

const RenameServer = ({ serverName }: { readonly serverName: string }): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(serverName);
  const rename = useMutation({
    mutationFn: () => runtime.admin.renameServer(name.trim()),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
  });
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          rename.reset();
          setName(serverName);
          setOpen(true);
        }}
      >
        Rename…
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Rename server"
        description="Everyone who connects to this server sees this name."
      >
        <Form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <TextField label="Server name" value={name} onValueChange={setName} autoFocus />
          {rename.isError ? (
            <p className="form-error" role="alert">
              <CircleAlert aria-hidden="true" size={15} />
              <span>{errorMessage(rename.error, "Could not rename the server")}</span>
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={rename.isPending || name.trim() === "" || name.trim() === serverName}
            >
              {rename.isPending ? "Renaming…" : "Rename"}
            </Button>
          </div>
        </Form>
      </Modal>
    </>
  );
};

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index));
const languageCodes = letters
  .flatMap((first) => letters.map((second) => first + second))
  .filter((code) => languageNames.of(code) !== code && new Intl.Locale(code).language === code);
const languageOptions = languageCodes
  .map((value) => ({ value, label: languageNames.of(value) ?? value }))
  .sort((a, b) => a.label.localeCompare(b.label));

const TrackSettings = ({ connectionId }: { readonly connectionId: string }): React.ReactElement => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const queryKey = ["track-preferences", connectionId];
  const preferences = useQuery({ queryKey, queryFn: () => runtime.trackSettings.read() });
  const update = useMutation({
    mutationFn: (input: TrackPreferencesPatch) => runtime.trackSettings.update(input),
    onSuccess: (value) => queryClient.setQueryData(queryKey, value),
  });
  if (preferences.isPending) return <p role="status">Loading audio and subtitle settings…</p>;
  if (preferences.isError)
    return (
      <div role="alert">
        {errorMessage(preferences.error, "Could not load playback settings")}
        <Button onClick={() => void preferences.refetch()}>Retry</Button>
      </div>
    );
  const options = [...languageOptions];
  for (const language of [preferences.data.audioLanguage, preferences.data.subtitleLanguage]) {
    if (language !== null && !options.some((option) => option.value === language))
      options.push({ value: language, label: languageNames.of(language) ?? language });
  }
  return (
    <>
      <SettingsRow
        label="Preferred audio"
        description="Used when this show or movie has no available saved choice."
      >
        <SelectField
          label="Preferred audio language"
          hideLabel
          value={preferences.data.audioLanguage}
          disabled={update.isPending}
          options={options}
          onValueChange={(audioLanguage) => update.mutate({ audioLanguage })}
        />
      </SettingsRow>
      <SettingsRow
        label="Preferred subtitles"
        description="Your saved show and movie choices stay in place when you change these settings."
      >
        <SelectField
          label="Preferred subtitles"
          hideLabel
          value={preferences.data.subtitleLanguage ?? "off"}
          disabled={update.isPending}
          options={[{ value: "off", label: "Off" }, ...options]}
          onValueChange={(value) =>
            update.mutate({ subtitleLanguage: value === "off" ? null : value })
          }
        />
      </SettingsRow>
      {update.isError ? (
        <p className="form-error" role="alert">
          {errorMessage(update.error, "Could not save playback settings")}
          <Button
            onClick={() => {
              if (update.variables !== undefined) update.mutate(update.variables);
            }}
          >
            Retry
          </Button>
        </p>
      ) : null}
    </>
  );
};

export const SettingsPage = (): React.ReactElement => {
  const { account, openConnections } = useWorkspace();
  const { capabilities } = useRuntime();
  const signInStorage =
    capabilities.signInStorage === "cookie"
      ? {
          label: "Browser cookie",
          description:
            "Your sign-in is kept in a cookie that pages and scripts cannot read. Sign out to remove it.",
        }
      : account.secureStorageAvailable
        ? {
            label: "Encrypted",
            description: "Your sign-in is encrypted with the system’s secure storage.",
          }
        : {
            label: "Not encrypted",
            description:
              "Secure storage is unavailable, so your sign-in is kept in a private file only your user account can read.",
          };
  return (
    <div className="page page-narrow">
      <PageHeader title="Settings" />
      <section className="settings-group" aria-labelledby="settings-playback">
        <h2 id="settings-playback">Playback</h2>
        <div className="settings-card">
          <TrackSettings key={account.connectionId} connectionId={account.connectionId} />
          <SettingsRow label="Player" description={capabilities.player.description}>
            {capabilities.player.name}
          </SettingsRow>
          <SettingsRow
            label="Quality"
            description="Files stream exactly as they are stored on the server."
          >
            Original
          </SettingsRow>
          <SettingsRow label="Transcoding" description="Lumen never re-encodes your media.">
            Off
          </SettingsRow>
        </div>
      </section>
      <section className="settings-group" aria-labelledby="settings-server">
        <h2 id="settings-server">Server</h2>
        <div className="settings-card">
          <SettingsRow label="Connected to" description={hostOf(account.origin)}>
            {account.serverName}
            {account.role === "admin" ? <RenameServer serverName={account.serverName} /> : null}
          </SettingsRow>
          <SettingsRow label="Signed in as">{account.username}</SettingsRow>
          <SettingsRow label="Role">{roleLabels[account.role]}</SettingsRow>
          <SettingsRow label="Sign-in storage" description={signInStorage.description}>
            {signInStorage.label}
          </SettingsRow>
          {capabilities.serverSwitching ? (
            <div className="settings-row settings-row-actions">
              <Button onClick={() => openConnections("saved")}>Switch server…</Button>
              <Button variant="ghost" onClick={() => openConnections("add")}>
                Add server…
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
};
