import { Button } from "@lumen/ui";
import type { ReactNode } from "react";
import { hostOf, roleLabels } from "./format";
import { useRuntime } from "./Runtime";
import { PageHeader, useWorkspace } from "./Workspace";

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
            {account.serverLabel}
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
