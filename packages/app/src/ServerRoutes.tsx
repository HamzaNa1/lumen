import { type AccountList, type AccountSummary, makeServerRoute } from "@lumen/contracts";
import { Button, Form, TextField } from "@lumen/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "./format";
import { useRuntime } from "./Runtime";
import { ACCOUNTS_KEY } from "./Workspace";

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

  const refresh = useMutation({
    mutationFn: () => {
      if (routesRuntime === null) throw new Error("Routes are unavailable here");
      return routesRuntime.refresh(account.connectionId);
    },
    onSuccess: (list) => {
      setError(null);
      sync(list);
    },
    onError: (cause) => setError(errorMessage(cause, "Could not check routes")),
  });

  if (routesRuntime === null) return null;

  const routes =
    account.routes && account.routes.length > 0
      ? account.routes
      : [makeServerRoute(account.origin, "manual")];
  const busy = add.isPending || remove.isPending || refresh.isPending;

  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-text">
          <span>Routes</span>
          <p>
            Local network routes are tried first. Lumen switches automatically if a route stops
            responding.
          </p>
        </div>
        <div className="settings-row-value">
          <Button size="sm" disabled={busy} onClick={() => refresh.mutate()}>
            {refresh.isPending ? "Checking…" : "Check routes"}
          </Button>
        </div>
      </div>
      {routes.map((route) => {
        const active = route.origin === account.origin;
        return (
          <div className="settings-row" key={route.origin}>
            <div className="settings-row-text">
              <span className="route-origin">{route.origin}</span>
              <p>{route.source === "detected" ? "Auto-detected" : "Added manually"}</p>
            </div>
            <div className="settings-row-value">
              {active ? <span className="status-pill is-positive">Active</span> : null}
              <span className="status-pill">{route.scope === "lan" ? "LAN" : "Remote"}</span>
              {routes.length > 1 ? (
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
