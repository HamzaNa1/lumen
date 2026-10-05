import { type AccountSummary, MIN_PASSWORD_LENGTH, type ServerDiscovery } from "@lumen/contracts";
import { Button, Form, Modal, TextField } from "@lumen/ui";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, hostOf, passwordRule } from "./format";
import { LumenMark } from "./LumenMark";
import { useRuntime } from "./Runtime";

export const ConnectPage = ({
  accounts = [],
  activeConnectionId,
  initialError,
  initialShowAddServer = false,
  initialSignInAccount,
  onClose,
  onChanged,
}: {
  readonly accounts?: ReadonlyArray<AccountSummary>;
  readonly activeConnectionId?: string;
  readonly initialError?: string;
  readonly initialShowAddServer?: boolean;
  readonly initialSignInAccount?: AccountSummary | null;
  readonly onClose?: () => void;
  readonly onChanged?: () => void;
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
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const creatingAccount = server?.setupRequired === true;
  const showingSaved = accounts.length > 0 && !showAddServer;
  const discoverServer = useMutation({
    mutationFn: () => runtime.accounts.discoverServer(origin),
    onSuccess: (result) => {
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
    onSuccess: () => {
      setPassword("");
      onChanged?.();
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
  const activateAccount = (account: AccountSummary): void => {
    setOpeningId(account.connectionId);
    setError(null);
    void runtime.accounts
      .activate(account.connectionId)
      .then(() => onChanged?.())
      .catch(async (cause) => {
        if (!errorMessage(cause, "").includes("Sign-in required")) {
          setError(errorMessage(cause, "Could not open server"));
          return;
        }
        await signInAgain(account);
      })
      .finally(() => setOpeningId(null));
  };
  const removeAccount = (connectionId: string): void => {
    void runtime.accounts
      .remove(connectionId)
      .then(() => onChanged?.())
      .catch((cause) => setError(errorMessage(cause, "Could not remove server")));
  };
  const signInAgain = useCallback(async (account: AccountSummary): Promise<void> => {
    setOrigin(account.origin);
    setUsername(account.username);
    setError(null);
    try {
      setServer(await runtime.accounts.discoverServer(account.origin));
      setShowAddServer(true);
    } catch (cause) {
      setError(errorMessage(cause, "Could not reach that server"));
    }
  }, [runtime]);
  useEffect(() => {
    if (initialSignInAccount != null) void signInAgain(initialSignInAccount);
  }, [initialSignInAccount, signInAgain]);
  const discoverFixedServer = discoverServer.mutate;
  useEffect(() => {
    if (fixedOrigin !== null) discoverFixedServer();
  }, [fixedOrigin, discoverFixedServer]);

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
          <LumenMark />
          <span>Lumen</span>
        </div>
        <section className="connect-card">
          <header className="connect-heading">
            <h1>{heading.title}</h1>
            <p>{heading.body}</p>
          </header>
          {showingSaved ? (
            <>
              <div className="server-list">
                {accounts.map((account) => (
                  <div className="server-row" key={account.connectionId}>
                    <button
                      className="server-row-open"
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
                        </span>
                      </span>
                      {openingId === account.connectionId ? (
                        <span className="server-row-status">Opening…</span>
                      ) : account.connectionId === activeConnectionId ? (
                        <span className="server-row-status">Current</span>
                      ) : null}
                      <ChevronRight aria-hidden="true" size={16} />
                    </button>
                    <Button
                      className="server-row-remove"
                      variant="icon"
                      size="sm"
                      aria-label={`Remove ${account.serverName}`}
                      onClick={() => setRemoving(account)}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                    </Button>
                  </div>
                ))}
              </div>
              {errorBanner}
              <Button
                className="button-wide"
                onClick={() => {
                  setShowAddServer(true);
                  setServer(null);
                  setError(null);
                }}
              >
                <Plus aria-hidden="true" size={16} />
                Add server
              </Button>
            </>
          ) : server === null && fixedOrigin !== null ? (
            <div className="connect-form">
              {errorBanner}
              {discoverServer.isError ? (
                <Button
                  className="button-wide"
                  variant="primary"
                  size="lg"
                  onClick={() => discoverServer.mutate()}
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
                discoverServer.mutate();
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
