import { Button, Form, Modal, TextField } from "@lumen/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
