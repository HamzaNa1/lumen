import { Menu } from "@base-ui/react/menu";
import type { IpcAccount } from "@lumen/contracts";
import { Check, ChevronsUpDown, LogOut, Plus, Server, Settings } from "lucide-react";
import { useState } from "react";
import { Button } from "./Button";
import { Modal } from "./Controls";

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export const Avatar = ({
  name,
  size = "md",
}: {
  readonly name: string;
  readonly size?: "sm" | "md" | "lg";
}): React.ReactElement => (
  <span className={`avatar avatar-${size}`} aria-hidden="true">
    {name.trim().slice(0, 1).toUpperCase() || "?"}
  </span>
);

export const AccountMenu = ({
  accounts,
  active,
  onActivate,
  onRemove,
  onAddServer,
  onOpenSettings,
}: {
  readonly accounts: ReadonlyArray<IpcAccount>;
  readonly active: IpcAccount;
  readonly onActivate: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onAddServer: () => void;
  readonly onOpenSettings: () => void;
}): React.ReactElement => {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="account-trigger">
          <Avatar name={active.username} />
          <span className="account-trigger-text">
            <strong>{active.username}</strong>
            <span>{active.serverLabel}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" size={15} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="menu-positioner" side="top" align="start" sideOffset={6}>
            <Menu.Popup className="menu-popup account-menu">
              <Menu.Group>
                <Menu.GroupLabel className="menu-label">Servers</Menu.GroupLabel>
                {accounts.map((account) => {
                  const current = account.connectionId === active.connectionId;
                  return (
                    <Menu.Item
                      key={account.connectionId}
                      className="menu-item account-menu-item"
                      onClick={() => {
                        if (!current) onActivate(account.connectionId);
                      }}
                    >
                      <span className="menu-item-icon">
                        <Server aria-hidden="true" size={15} />
                      </span>
                      <span className="menu-item-label">
                        {account.serverLabel}
                        <small>
                          {account.username} · {hostOf(account.origin)}
                        </small>
                      </span>
                      {current ? (
                        <span className="menu-item-trailing">
                          <Check aria-label="Current server" size={15} />
                        </span>
                      ) : null}
                    </Menu.Item>
                  );
                })}
              </Menu.Group>
              <Menu.Item className="menu-item" onClick={onAddServer}>
                <span className="menu-item-icon">
                  <Plus aria-hidden="true" size={15} />
                </span>
                <span className="menu-item-label">Add server…</span>
              </Menu.Item>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item" onClick={onOpenSettings}>
                <span className="menu-item-icon">
                  <Settings aria-hidden="true" size={15} />
                </span>
                <span className="menu-item-label">Settings</span>
              </Menu.Item>
              <Menu.Item
                className="menu-item"
                data-tone="danger"
                onClick={() => setConfirmingRemove(true)}
              >
                <span className="menu-item-icon">
                  <LogOut aria-hidden="true" size={15} />
                </span>
                <span className="menu-item-label">Sign out of {active.serverLabel}…</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Modal
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title={`Sign out of ${active.serverLabel}?`}
        description="This removes the server and its saved sign-in from this device. Nothing on the server is deleted."
      >
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmingRemove(false);
              onRemove(active.connectionId);
            }}
          >
            Sign out
          </Button>
        </div>
      </Modal>
    </>
  );
};
