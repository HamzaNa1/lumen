import {
  type AccountList,
  type AccountSummary,
  makeServerRoute,
  type ServerRouteScope,
} from "@lumen/contracts";
import { Button, Form, TextField } from "@lumen/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "./format";
import { useRuntime } from "./Runtime";
import { ACCOUNTS_KEY } from "./Workspace";

export const scopeLabel = (scope: ServerRouteScope): string =>
  scope === "local" ? "Local" : scope === "lan" ? "LAN" : scope === "vpn" ? "VPN" : "Remote";

export const ServerRoutesSection = ({
  account,
  onUpdated,
}: {
  readonly account: AccountSummary;
  readonly onUpdated?: ((list: AccountList) => void) | undefined;
}): React.ReactElement | null => {
  const { routes: routesRuntime } = useRuntime();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sync = (list: AccountList): void => {
    queryClient.setQueryData(ACCOUNTS_KEY, list);
    onUpdated?.(list);
  };

  const add = useMutation({
    mutationFn: (origin: string) => {
      if (routesRuntime === null) throw new Error("Routes are unavailable here");
      return routesRuntime.add(account.connectionId, origin);
    },
    onSuccess: (list) => {
      setDraft("");
      setError(null);
      sync(list);
    },
    onError: (cause) => setError(errorMessage(cause, "Could not add that route")),
  });

  const remove = useMutation({
    mutationFn: (origin: string) => {
      if (routesRuntime === null) throw new Error("Routes are unavailable here");
      return routesRuntime.remove(account.connectionId, origin);
    },
    onSuccess: (list) => {
      setError(null);
      sync(list);
    },
    onError: (cause) => setError(errorMessage(cause, "Could not remove that route")),
  });

  if (routesRuntime === null) return null;

  const routes =
    account.routes && account.routes.length > 0
      ? account.routes
      : [makeServerRoute(account.origin, "manual")];
  const needingSignIn = account.routesNeedingSignIn ?? [];
  const busy = add.isPending || remove.isPending;

  return (
    <div className="settings-card">
      {[...routes, ...needingSignIn].map((route) => {
        const active = route.origin === account.origin;
        const signInRequired = needingSignIn.includes(route);
        const removable = signInRequired || routes.length > 1;
        return (
          <div className="settings-row" key={route.origin}>
            <div className="settings-row-text">
              <span className="route-origin">{route.origin}</span>
              <p>
                {signInRequired
                  ? "Sign in at this address to use it."
                  : route.source === "detected"
                    ? "Auto-detected"
                    : "Added manually"}
              </p>
            </div>
            <div className="settings-row-value">
              {active ? <span className="status-pill is-positive">Active</span> : null}
              {signInRequired ? <span className="status-pill">Sign-in required</span> : null}
              <span className="status-pill">{scopeLabel(route.scope)}</span>
              {removable ? (
                <Button
                  variant="icon"
                  size="sm"
                  aria-label={`Remove route ${route.origin}`}
                  disabled={busy}
                  onClick={() => remove.mutate(route.origin)}
                >
                  <Trash2 aria-hidden="true" size={14} />
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      <div className="settings-row route-add-row">
        <Form
          className="route-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() !== "") add.mutate(draft.trim());
          }}
        >
          <TextField
            label="Route address"
            hideLabel
            value={draft}
            onValueChange={(value) => {
              setDraft(value);
              setError(null);
            }}
            placeholder="http://192.168.1.10:3210 or https://media.example"
            disabled={busy}
          />
          <Button type="submit" variant="primary" disabled={busy || draft.trim() === ""}>
            {add.isPending ? "Adding…" : "Add route"}
          </Button>
        </Form>
        {error === null ? null : (
          <p className="form-error route-error" role="alert">
            <CircleAlert aria-hidden="true" size={15} />
            <span>{error}</span>
          </p>
        )}
      </div>
    </div>
  );
};
