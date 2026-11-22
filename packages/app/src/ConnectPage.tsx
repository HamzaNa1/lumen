import {
  type AccountList,
  type AccountSummary,
  classifyRouteScope,
  MIN_PASSWORD_LENGTH,
  type ServerDiscovery,
} from "@lumen/contracts";

import { Button, Form, Modal, TextField } from "@lumen/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Plus,
  Route,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, hostOf, passwordRule } from "./format";
import { LumenLogo } from "./LumenLogo";
import { useRuntime } from "./Runtime";
import { ServerRoutesSection } from "./ServerRoutes";

export const ReconnectingView = ({
  account,
  hasDownloads,
  onCancel,
  onOpenDownloads,
}: {
  readonly account: AccountSummary;
  readonly hasDownloads: boolean;
  readonly onCancel: () => void;
  readonly onOpenDownloads: () => void;
}): React.ReactElement => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <main className="connect-page" aria-label={`Reconnecting to ${account.serverName}`}>
      <div className="connect-column">
        <div className="connect-brand">
          <LumenLogo />
        </div>
        <section className="connect-card connect-reconnecting">
          <header className="connect-heading">
            <h1>Reconnecting…</h1>
            <p>Waiting for your last server to respond.</p>
          </header>
          <div className="server-chip is-connecting" role="status" aria-live="polite">
            <span className="server-row-icon">
              <Server aria-hidden="true" size={16} />
            </span>
            <span className="server-row-text">
              <strong>{account.serverName}</strong>
              <span>
                {account.username} · {hostOf(account.origin)}
              </span>
            </span>
            <LoaderCircle className="spinner connect-target-spinner" aria-hidden="true" size={16} />
          </div>
          <div className="connect-actions">
            {hasDownloads ? (
              <>
                <Button
                  className="button-wide"
                  variant="secondary"
                  size="lg"
                  onClick={onOpenDownloads}
                >
                  <ArrowDownToLine aria-hidden="true" size={16} />
                  Open downloads
                </Button>
                <Button className="button-wide" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button className="button-wide" variant="secondary" size="lg" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
};

export const ConnectPage = ({
  accounts = [],
  activeConnectionId,
  initialError,
  initialShowAddServer = false,
  initialSignInAccount,
  onClose,
  onChanged,
  onRemoved,
}: {
  readonly accounts?: ReadonlyArray<AccountSummary>;
  readonly activeConnectionId?: string | undefined;
  readonly initialError?: string | undefined;
  readonly initialShowAddServer?: boolean;
  readonly initialSignInAccount?: AccountSummary | null;
  readonly onClose?: (() => void) | undefined;
  readonly onChanged?: (result?: AccountList) => void;
  readonly onRemoved?: (connectionId: string) => void;
}): React.ReactElement => {
  const runtime = useRuntime();
  // A platform tied to one server skips the address step and goes straight to signing in.
  const fixedOrigin = runtime.accounts.fixedOrigin;
  const [origin, setOrigin] = useState(fixedOrigin ?? "http://127.0.0.1:3210");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState<ServerDiscovery | null>(null);
  const [showAddServer, setShowAddServer] = useState(
    accounts.length === 0 || initialShowAddServer || initialSignInAccount != null,
  );
  const [removing, setRemoving] = useState<AccountSummary | null>(null);
  const [managingRoutesId, setManagingRoutesId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const openingAttemptId = useRef(0);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const creatingAccount = server?.setupRequired === true;
  const showingSaved = accounts.length > 0 && !showAddServer;
  const managingRoutes =
    managingRoutesId === null
      ? null
      : (accounts.find((account) => account.connectionId === managingRoutesId) ?? null);
  const lanServers = useQuery({
    queryKey: ["lan-servers"],
    queryFn: () => runtime.routes?.discoverLan() ?? Promise.resolve([]),
    enabled: runtime.routes !== null && fixedOrigin === null && !showingSaved && server === null,
    staleTime: 5_000,
    retry: false,
  });
  const discoverServer = useMutation({
    mutationFn: (targetOrigin?: string) => runtime.accounts.discoverServer(targetOrigin ?? origin),
    onSuccess: (result) => {
      setOrigin(result.origin);
      setServer(result);
      setError(null);
    },
    onError: (cause) => setError(errorMessage(cause, "Could not reach that server")),
  });
  const connect = useMutation({
    mutationFn: () => {
      if (server === null) throw new Error("Connect to a server first");
      return runtime.accounts.connect({
        origin: server.origin,
        username,
        displayName: creatingAccount ? displayName || username : undefined,
        password,
      });
    },
    onSuccess: (result) => {
      setPassword("");
      onChanged?.(result);
    },
    onError: (cause) =>
      setError(
        errorMessage(cause, creatingAccount ? "Could not create account" : "Could not sign in"),
      ),
  });
  const changeServer = (): void => {
    setServer(null);
    setUsername("");
    setDisplayName("");
    setPassword("");
    setError(null);
  };
  const cancelOpening = useCallback((): void => {
    openingAttemptId.current += 1;
    setOpeningId(null);
    void runtime.accounts.cancelActivate().catch(() => undefined);
  }, [runtime]);
  const activateAccount = (account: AccountSummary): void => {
    const attempt = ++openingAttemptId.current;
    setOpeningId(account.connectionId);
    setError(null);
    void runtime.accounts
      .activate(account.connectionId)
      .then((result) => {
        if (openingAttemptId.current !== attempt) return;
        onChanged?.(result);
      })
      .catch(async (cause) => {
        if (openingAttemptId.current !== attempt) return;
        if (!errorMessage(cause, "").includes("Sign-in required")) {
          setError(errorMessage(cause, "Could not open server"));
          return;
        }
        await signInAgain(account);
      })
      .finally(() => {
        if (openingAttemptId.current === attempt) setOpeningId(null);
      });
  };
  const removeAccount = (connectionId: string): void => {
    void runtime.accounts
      .remove(connectionId)
      .then(() => (onRemoved ? onRemoved(connectionId) : onChanged?.()))
      .catch((cause) => setError(errorMessage(cause, "Could not remove server")));
  };
  const signInAgain = useCallback(
    async (account: AccountSummary): Promise<void> => {
      setOrigin(account.origin);
      setUsername(account.username);
      setError(null);
      try {
        setServer(await runtime.accounts.discoverServer(account.origin));
        setShowAddServer(true);
      } catch (cause) {
        setError(errorMessage(cause, "Could not reach that server"));
      }
    },
    [runtime],
  );
  useEffect(() => {
    if (initialSignInAccount != null) void signInAgain(initialSignInAccount);
  }, [initialSignInAccount, signInAgain]);
  const discoverFixedServer = discoverServer.mutate;
  useEffect(() => {
    if (fixedOrigin !== null && !showingSaved && server === null) discoverFixedServer(fixedOrigin);
  }, [fixedOrigin, showingSaved, server, discoverFixedServer]);

  const heading = showingSaved
    ? { title: "Choose a server", body: "Select a server to continue." }
    : server === null
      ? fixedOrigin === null
        ? {
            title: "Connect to a server",
            body: "Enter the address of a Lumen server on your network.",
          }
        : discoverServer.isError
          ? { title: "Can’t reach the server", body: "Lumen could not load from this address." }
          : { title: "Connecting…", body: "Checking this server." }
      : server.setupRequired
        ? {
            title: "Create the admin account",
            body: "This server is new. The first account manages its users and libraries.",
          }
        : { title: "Sign in", body: `Sign in to ${server.identity.displayName}.` };

  const errorBanner =
    error === null ? null : (
      <p className="form-error" role="alert">
        <CircleAlert aria-hidden="true" size={15} />
        <span>{error}</span>
      </p>
    );

  return (
    <main className="connect-page">
      {onClose === undefined ? null : (
        <Button className="connect-close" variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft aria-hidden="true" size={15} />
          Back
        </Button>
      )}
      <div className="connect-column">
        <div className="connect-brand">
          <LumenLogo />
        </div>
        <section className="connect-card">
          <header className="connect-heading">
            <h1>{heading.title}</h1>
            <p>{heading.body}</p>
          </header>
          {showingSaved ? (
            <>
              <div className="server-list">
                {accounts.map((account) => {
                  const opening = openingId === account.connectionId;
                  return (
                    <div className="server-row" key={account.connectionId}>
                      <button
                        className={`server-row-open${opening ? " is-opening" : ""}`}
                        type="button"
                        onClick={() => activateAccount(account)}
                        disabled={openingId !== null}
                      >
                        <span className="server-row-icon">
                          <Server aria-hidden="true" size={16} />
                        </span>
                        <span className="server-row-text">
                          <strong>{account.serverName}</strong>
                          <span>
                            {account.username} · {hostOf(account.origin)}
                            {account.routes && account.routes.length > 1
                              ? ` · ${account.routes.length} routes`
                              : ""}
                          </span>
                        </span>
                        {opening ? (
                          <LoaderCircle
                            className="spinner server-row-spinner"
                            aria-hidden="true"
                            size={15}
                          />
                        ) : account.connectionId === activeConnectionId ? (
                          <span className="server-row-status">Current</span>
                        ) : null}
                        {opening ? null : <ChevronRight aria-hidden="true" size={16} />}
                      </button>
                      {opening ? (
                        <Button
                          className="server-row-cancel"
                          variant="ghost"
                          size="sm"
                          onClick={cancelOpening}
                        >
                          Cancel
                        </Button>
                      ) : (
                        <>
                          {runtime.routes === null ? null : (
                            <Button
                              className="server-row-remove"
                              variant="icon"
                              size="sm"
                              aria-label={`Routes for ${account.serverName}`}
                              disabled={openingId !== null}
                              onClick={() => setManagingRoutesId(account.connectionId)}
                            >
                              <Route aria-hidden="true" size={15} />
                            </Button>
                          )}
                          <Button
                            className="server-row-remove"
                            variant="icon"
                            size="sm"
                            aria-label={`Remove ${account.serverName}`}
                            disabled={openingId !== null}
                            onClick={() => setRemoving(account)}
                          >
                            <Trash2 aria-hidden="true" size={15} />
                          </Button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {errorBanner}
              {fixedOrigin === null ? (
                <Button
                  className="button-wide"
                  disabled={openingId !== null}
                  onClick={() => {
                    setShowAddServer(true);
                    setServer(null);
                    setError(null);
                  }}
                >
                  <Plus aria-hidden="true" size={16} />
                  Add server
                </Button>
              ) : null}
            </>
          ) : server === null && fixedOrigin !== null ? (
            <div className="connect-form">
              {errorBanner}
              {discoverServer.isError ? (
                <Button
                  className="button-wide"
                  variant="primary"
                  size="lg"
                  onClick={() => discoverServer.mutate(fixedOrigin)}
                >
                  Try again
                </Button>
              ) : (
                <LoaderCircle className="spinner" aria-hidden="true" size={22} />
              )}
            </div>
          ) : server === null ? (
            <Form
              className="connect-form"
              onSubmit={(event) => {
                event.preventDefault();
                discoverServer.mutate(origin);
              }}
            >
              <TextField
                label="Server address"
                value={origin}
                onValueChange={(value) => {
                  setOrigin(value);
                  setError(null);
                }}
                placeholder="http://192.168.1.10:3210"
                autoFocus
              />
              {errorBanner}
              <Button
                className="button-wide"
                variant="primary"
                size="lg"
                type="submit"
                disabled={discoverServer.isPending || origin.trim() === ""}
              >
                {discoverServer.isPending ? "Connecting…" : "Continue"}
              </Button>
              {lanServers.data && lanServers.data.length > 0 ? (
                <div className="lan-discovered">
                  <p className="lan-discovered-heading">On your network</p>
                  <div className="server-list">
                    {lanServers.data.map((candidate) => (
                      <button
                        key={candidate.origin}
                        className="server-row-open"
                        type="button"
                        disabled={discoverServer.isPending}
                        onClick={() => {
                          setOrigin(candidate.origin);
                          discoverServer.mutate(candidate.origin);
                        }}
                      >
                        <span className="server-row-icon">
                          <Server aria-hidden="true" size={16} />
                        </span>
                        <span className="server-row-text">
                          <strong>{candidate.displayName}</strong>
                          <span>{hostOf(candidate.origin)}</span>
                        </span>
                        <span className="status-pill">
                          {classifyRouteScope(candidate.origin) === "local" ? "Local" : "LAN"}
                        </span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {accounts.length > 0 ? (
                <Button
                  className="button-wide"
                  variant="ghost"
                  onClick={() => {
                    setShowAddServer(false);
                    setError(null);
                  }}
                >
                  Back to saved servers
                </Button>
              ) : null}
            </Form>
          ) : (
            <Form
              className="connect-form"
              onSubmit={(event) => {
                event.preventDefault();
                connect.mutate();
              }}
            >
              <div className="server-chip">
                <span className="server-row-icon">
                  <Server aria-hidden="true" size={15} />
                </span>
                <span className="server-row-text">
                  <strong>{server.identity.displayName}</strong>
                  <span>{hostOf(server.origin)}</span>
                </span>
                {fixedOrigin === null ? (
                  <Button variant="ghost" size="sm" onClick={changeServer}>
                    Change
                  </Button>
                ) : null}
              </div>
              <TextField
                label="Username"
                autoComplete="username"
                value={username}
                onValueChange={setUsername}
                autoFocus
              />
              {creatingAccount ? (
                <TextField
                  label="Display name"
                  value={displayName}
                  onValueChange={setDisplayName}
                  placeholder={username === "" ? undefined : username}
                  description="Shown to other people on this server."
                />
              ) : null}
              <TextField
                label="Password"
                type="password"
                autoComplete={creatingAccount ? "new-password" : "current-password"}
                value={password}
                onValueChange={setPassword}
                description={creatingAccount ? passwordRule : undefined}
              />
              {errorBanner}
              <Button
                className="button-wide"
                variant="primary"
                size="lg"
                type="submit"
                disabled={
                  connect.isPending ||
                  username.trim() === "" ||
                  password === "" ||
                  (creatingAccount && password.length < MIN_PASSWORD_LENGTH)
                }
              >
                {connect.isPending
                  ? creatingAccount
                    ? "Creating account…"
                    : "Signing in…"
                  : creatingAccount
                    ? "Create account"
                    : "Sign in"}
              </Button>
            </Form>
          )}
        </section>
      </div>
      <Modal
        open={managingRoutes !== null}
        onOpenChange={(open) => {
          if (!open) setManagingRoutesId(null);
        }}
        title={`Routes for ${managingRoutes?.serverName ?? "server"}`}
        description="Local and LAN routes are detected automatically and tried first."
      >
        {managingRoutes === null ? null : <ServerRoutesSection account={managingRoutes} />}
      </Modal>
      <Modal
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.serverName ?? "server"}?`}
        description="This removes the saved sign-in from this device. Nothing on the server is deleted."
      >
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (removing !== null) removeAccount(removing.connectionId);
              setRemoving(null);
            }}
          >
            Remove server
          </Button>
        </div>
      </Modal>
    </main>
  );
};
