import { Button } from "./Button";
import type { IpcAccount } from "@lumen/contracts";

export const AccountSwitcher = ({ accounts, activeId, onActivate, onRemove }: { readonly accounts: ReadonlyArray<IpcAccount>; readonly activeId: string | null; readonly onActivate: (id: string) => void; readonly onRemove: (id: string) => void }): React.ReactElement => (
  <div className="account-switcher">
    <label htmlFor="account-select">Account</label>
    <select id="account-select" value={activeId ?? ""} onChange={(event) => onActivate(event.target.value)}>
      {accounts.length === 0 ? <option value="">No accounts</option> : accounts.map((account) => <option key={account.connectionId} value={account.connectionId}>{account.serverLabel} · {account.username}</option>)}
    </select>
    {activeId === null ? null : <Button variant="ghost" onClick={() => onRemove(activeId)}>Remove</Button>}
  </div>
);
