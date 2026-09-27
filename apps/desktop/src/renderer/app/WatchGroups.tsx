import type { WatchGroupStatus, WatchGroupSummary } from "@lumen/contracts";
import { Button, Modal, TextField } from "@lumen/ui";
import {
  Check,
  ChevronRight,
  CirclePlay,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "./format";
import "./watch-groups.css";

const bridge = window.lumen;
const initialStatus: WatchGroupStatus = { group: null, connected: true, error: null };

export const WatchGroups = (): React.ReactElement => {
  const [status, setStatus] = useState(initialStatus);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"groups" | "create" | "password">("groups");
  const [groups, setGroups] = useState<ReadonlyArray<WatchGroupSummary>>([]);
  const [selected, setSelected] = useState<WatchGroupSummary | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = bridge.watchGroups.onState(setStatus);
    void bridge.watchGroups
      .state()
      .then(setStatus)
      .catch(() => undefined);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!open || status.group !== null || view !== "groups") return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      setLoading(true);
      try {
        const next = await bridge.watchGroups.list();
        if (!cancelled) {
          setGroups(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause, "Could not load watch groups"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, status.group, view]);

  const run = async (action: () => Promise<WatchGroupStatus>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
      setView("groups");
      setPassword("");
    } catch (cause) {
      setError(errorMessage(cause, "Could not update watch group"));
    } finally {
      setBusy(false);
    }
  };
  const group = status.group;
  const changeOpen = (next: boolean): void => {
    if (busy) return;
    setOpen(next);
    setView("groups");
    setPassword("");
    setError(null);
  };
  const title =
    view === "create"
      ? "Create a group"
      : view === "password"
        ? "Join group"
        : (group?.name ?? "Join a group");

  return (
    <>
      <Button
        variant="icon"
        className={`watch-group-trigger${group === null ? "" : " is-active"}`}
        aria-label={group === null ? "Watch groups" : `Watch group: ${group.name}`}
        title={group === null ? "Watch together" : group.name}
        onClick={() => changeOpen(true)}
      >
        <UsersRound size={21} aria-hidden="true" />
        {group === null ? null : <span className="watch-group-count">{group.members.length}</span>}
      </Button>
      <Modal
        open={open}
        onOpenChange={changeOpen}
        title={title}
        className="watch-group-dialog"
        description={
          view === "groups"
            ? group === null
              ? "Watch together, wherever you are."
              : "Everyone in this group can control playback."
            : undefined
        }
      >
        {(error ?? status.error) ? (
          <p className="watch-group-error" role="alert">
            {error ?? status.error}
          </p>
        ) : null}
        {view === "create" || view === "password" ? (
          <form
            className="watch-group-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (view === "create")
                void run(() => bridge.watchGroups.create({ name: name.trim(), password }));
              else if (selected !== null)
                void run(() => bridge.watchGroups.join(selected.id, password));
            }}
          >
            {view === "create" ? (
              <TextField
                label="Group name"
                placeholder="Friday movie night"
                value={name}
                onValueChange={setName}
                maxLength={80}
                required
                disabled={busy}
              />
            ) : (
              <div className="watch-group-joining">
                <LockKeyhole size={20} />
                <div>
                  <strong>{selected?.name}</strong>
                  <p>This group is password protected.</p>
                </div>
              </div>
            )}
            <TextField
              label={view === "create" ? "Password (optional)" : "Group password"}
              description={
                view === "create" ? "Leave empty to let anyone on this server join." : undefined
              }
              type="password"
              autoComplete="off"
              value={password}
              onValueChange={setPassword}
              maxLength={128}
              required={view === "password"}
              disabled={busy}
            />
            <div className="watch-group-form-actions">
              <Button
                variant="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setView("groups");
                  setPassword("");
                  setError(null);
                }}
              >
                Back
              </Button>
              <Button
                type="submit"
                disabled={busy || (view === "create" && name.trim().length === 0)}
              >
                {busy ? <LoaderCircle size={16} className="spinner" /> : null}
                {view === "create" ? "Create group" : "Join group"}
              </Button>
            </div>
          </form>
        ) : group === null ? (
          <>
            <div className="watch-group-section-label">
              <span>Available groups</span>
              {loading ? (
                <LoaderCircle className="spinner" size={14} aria-label="Refreshing groups" />
              ) : (
                <span>{groups.length}</span>
              )}
            </div>
            <div className="watch-group-list">
              {groups.map((entry) => (
                <button
                  key={entry.id}
                  className="watch-group-row"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (entry.passwordProtected) {
                      setSelected(entry);
                      setPassword("");
                      setError(null);
                      setView("password");
                    } else void run(() => bridge.watchGroups.join(entry.id));
                  }}
                >
                  <span className="watch-group-icon">
                    <UsersRound size={22} />
                  </span>
                  <span className="watch-group-row-copy">
                    <strong>{entry.name}</strong>
                    <span>{entry.members.map((member) => member.displayName).join(", ")}</span>
                  </span>
                  {entry.passwordProtected ? (
                    <LockKeyhole size={15} aria-label="Password protected" />
                  ) : null}
                  <ChevronRight size={16} className="watch-group-chevron" />
                </button>
              ))}
              {groups.length === 0 && !loading ? (
                <div className="watch-group-empty">
                  <UsersRound size={32} />
                  <strong>No groups yet</strong>
                  <p>Create one and invite others to join you.</p>
                </div>
              ) : null}
            </div>
            <button
              className="watch-group-row watch-group-create"
              type="button"
              disabled={busy}
              onClick={() => {
                setView("create");
                setName("");
                setPassword("");
                setError(null);
              }}
            >
              <span className="watch-group-icon">
                <Plus size={23} />
              </span>
              <span className="watch-group-row-copy">
                <strong>New group</strong>
                <span>Create a group to watch with friends</span>
              </span>
            </button>
            <p className="watch-group-footnote">
              Play, pause, and seek together. New members join at the current position.
            </p>
          </>
        ) : (
          <>
            <div className={`watch-group-sync${status.connected ? "" : " is-reconnecting"}`}>
              {status.connected ? <Radio size={16} /> : <RefreshCw size={16} className="spinner" />}
              <span>{status.connected ? "SyncPlay enabled" : "Reconnecting…"}</span>
              {group.passwordProtected ? (
                <LockKeyhole size={14} aria-label="Password protected" />
              ) : null}
            </div>
            <div className="watch-group-now-playing">
              <CirclePlay size={25} />
              <div>
                <span>
                  {group.playback === null
                    ? "Ready to watch"
                    : group.playback.paused
                      ? "Paused for everyone"
                      : "Now playing"}
                </span>
                <strong>{group.playback?.title ?? "Choose something from your library"}</strong>
              </div>
            </div>
            <div className="watch-group-section-label">
              <span>In this group</span>
              <span>
                {group.members.length} {group.members.length === 1 ? "member" : "members"}
              </span>
            </div>
            <ul className="watch-group-members">
              {group.members.map((member) => (
                <li key={member.id}>
                  <span className="watch-group-avatar">
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{member.displayName}</span>
                  <Check size={16} aria-label="Joined" />
                </li>
              ))}
            </ul>
            <p className="watch-group-footnote">
              Playback stays in sync automatically. Anyone can play, pause, or seek.
            </p>
            <button
              className="watch-group-row watch-group-leave"
              type="button"
              disabled={busy}
              onClick={() => void run(() => bridge.watchGroups.leave())}
            >
              <LogOut size={20} />
              <span>Leave group</span>
              {busy ? <LoaderCircle size={16} className="spinner" /> : null}
            </button>
          </>
        )}
      </Modal>
    </>
  );
};
