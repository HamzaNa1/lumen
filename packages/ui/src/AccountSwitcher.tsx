import type { IpcAccount } from "@lumen/contracts";
import { LogOut, Server } from "lucide-react";
import { useState } from "react";
import { Button } from "./Button";
import { Modal, SelectField } from "./Controls";

export const AccountSwitcher = ({
  accounts,
  activeId,
  onActivate,
  onRemove,
}: {
  readonly accounts: ReadonlyArray<IpcAccount>;
  readonly activeId: string | null;
  readonly onActivate: (id: string) => void;
  readonly onRemove: (id: string) => void;
}): React.ReactElement => {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const activeAccount = accounts.find((account) => account.connectionId === activeId);
  return (
    <div className="account-switcher">
      <div className="account-heading">
        <Server aria-hidden="true" size={16} />
        <span>Connection</span>
      </div>
      <SelectField
        hideLabel
        label="Connection"
        value={activeId}
        options={accounts.map((account) => ({
          value: account.connectionId,
          label: `${account.serverLabel} · ${account.username}`,
        }))}
        onValueChange={onActivate}
        placeholder={accounts.length === 0 ? "No saved connections" : "Choose a connection"}
        disabled={accounts.length === 0}
      />
      {activeId === null ? null : (
        <>
          <Button
            className="account-remove"
            variant="ghost"
            onClick={() => setConfirmingRemove(true)}
          >
            <LogOut aria-hidden="true" size={15} />
            Remove connection
          </Button>
          <Modal
            open={confirmingRemove}
            onOpenChange={setConfirmingRemove}
            title={`Remove ${activeAccount?.serverLabel ?? "this connection"}?`}
            description="You will need to enter the server address and sign in again to reconnect. Nothing on the server will be deleted."
          >
            <div className="confirm-actions">
              <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmingRemove(false);
                  onRemove(activeId);
                }}
              >
                Remove connection
              </Button>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
};
