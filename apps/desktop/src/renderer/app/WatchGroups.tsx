import type { WatchAction, WatchGroup, WatchStatus } from "@lumen/contracts";
import { Button, Modal, TextField } from "@lumen/ui";
import {
  Check,
  ChevronRight,
  CirclePlay,
  LockKeyhole,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "./format";
import "./watch-groups.css";

const initial: WatchStatus = {
  connection: "offline",
  memberId: null,
  groups: [],
  group: null,
  error: null,
};

export const WatchGroups = ({
  compact = false,
}: {
  readonly compact?: boolean;
}): React.ReactElement => {
  const [status, setStatus] = useState(initial);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"groups" | "create" | "password">("groups");
  const [selected, setSelected] = useState<WatchGroup | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const unsubscribe = window.lumen.watch.onState(setStatus);
    void window.lumen.watch
      .state()
      .then(setStatus)
      .catch(() => undefined);
    return unsubscribe;
  }, []);
  const perform = async (action: WatchAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.lumen.watch.action(action));
      setPassword("");
      setView("groups");
    } catch (cause) {
      setError(errorMessage(cause, "Could not update watch group"));
    } finally {
      setBusy(false);
    }
  };
  const group = status.group;
  const disabled = busy || status.connection !== "connected";
  const changeOpen = (next: boolean): void => {
    setOpen(next);
    setView("groups");
    setPassword("");
    setError(null);
    if (next)
      void window.lumen.watch
        .state()
        .then(setStatus)
        .catch((cause: unknown) => setError(errorMessage(cause, "Could not connect")));
  };
  return (
    <>
      <Button
        variant={compact ? "icon" : "ghost"}
        className={`watch-trigger${group === null ? "" : " is-active"}`}
        aria-label="Watch groups"
        title={group?.name ?? "Watch groups"}
        onClick={() => changeOpen(true)}
      >
        <Users size={compact ? 21 : 17} aria-hidden="true" />
        {compact ? null : <span>{group?.name ?? "Watch groups"}</span>}
        {group === null ? null : <span className="watch-active-dot" />}
      </Button>
      <Modal
        open={open}
        onOpenChange={changeOpen}
        title={
          view === "create"
            ? "New group"
            : view === "password"
              ? "Join protected group"
              : (group?.name ?? "Join a group")
        }
        description="Watch together, wherever you are."
        className="watch-dialog"
      >
        <div className="watch-connection">
          <Radio size={13} aria-hidden="true" />
          <span>
            {status.connection === "connected"
              ? "SyncPlay · Connected"
              : status.connection === "connecting"
                ? "Connecting…"
                : "Reconnecting…"}
          </span>
          {group?.hasPassword ? <LockKeyhole size={13} aria-label="Password protected" /> : null}
        </div>
        {error !== null || status.error !== null ? (
          <p className="watch-error" role="alert">
            {error ?? status.error}
          </p>
        ) : null}
        {view === "create" || view === "password" ? (
          <form
            className="watch-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (view === "create") void perform({ type: "create", name: name.trim(), password });
              else if (selected !== null)
                void perform({ type: "join", groupId: selected.id, password });
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
              />
            ) : (
              <div className="watch-selected">
                <Users size={20} />
                <strong>{selected?.name}</strong>
              </div>
            )}
            <TextField
              label={view === "create" ? "Password (optional)" : "Group password"}
              description={
                view === "create"
                  ? "Leave blank to let anyone on this server join."
                  : "Ask someone in the group for the password."
              }
              type="password"
              autoComplete="new-password"
              value={password}
              onValueChange={setPassword}
              maxLength={128}
              required={view === "password"}
            />
            <div className="dialog-actions">
              <Button
                variant="ghost"
                onClick={() => {
                  setView("groups");
                  setPassword("");
                  setError(null);
                }}
              >
                Back
              </Button>
              <Button type="submit" disabled={disabled || (view === "create" && !name.trim())}>
                {busy ? "Please wait…" : view === "create" ? "Create group" : "Join group"}
              </Button>
            </div>
          </form>
        ) : group !== null ? (
          <>
            <div className="watch-now-playing">
              <CirclePlay size={28} aria-hidden="true" />
              <div>
                <span className="watch-eyebrow">
                  {group.playback === null
                    ? "READY TO WATCH"
                    : group.playback.paused
                      ? "PAUSED TOGETHER"
                      : "WATCHING TOGETHER"}
                </span>
                <strong>{group.playback?.title ?? "Choose something to play"}</strong>
                <p>
                  {group.playback === null
                    ? "Play a movie or episode to start for everyone."
                    : "Everyone can play, pause, and seek."}
                </p>
              </div>
            </div>
            <div className="watch-section-label">
              Group members <span>{group.members.length}</span>
            </div>
            <div className="watch-members">
              {group.members.map((member) => (
                <div className="watch-member" key={member.id}>
                  <span className="watch-avatar">
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    {member.displayName}
                    {member.id === status.memberId ? <small> (you)</small> : null}
                  </span>
                  <Check size={15} aria-label="Connected" />
                </div>
              ))}
            </div>
            <div className="watch-footer">
              <span>
                <RefreshCw size={13} aria-hidden="true" /> Automatic synchronization
              </span>
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => void perform({ type: "leave" })}
              >
                <LogOut size={16} aria-hidden="true" />
                Leave group
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="watch-section-label">
              Available groups <span>{status.groups.length}</span>
            </div>
            <div className="watch-group-list">
              {status.groups.map((entry) => (
                <button
                  className="watch-group-row"
                  type="button"
                  key={entry.id}
                  disabled={disabled}
                  onClick={() => {
                    if (entry.hasPassword) {
                      setSelected(entry);
                      setPassword("");
                      setError(null);
                      setView("password");
                    } else void perform({ type: "join", groupId: entry.id, password: "" });
                  }}
                >
                  <span className="watch-group-icon">
                    <Users size={22} aria-hidden="true" />
                  </span>
                  <span className="watch-group-info">
                    <strong>{entry.name}</strong>
                    <span>{entry.members.map((member) => member.displayName).join(", ")}</span>
                  </span>
                  {entry.hasPassword ? (
                    <LockKeyhole size={16} aria-label="Password protected" />
                  ) : null}
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              ))}
              {status.groups.length === 0 ? (
                <div className="watch-empty">
                  <Users size={30} aria-hidden="true" />
                  <strong>No groups yet</strong>
                  <p>Create a group and invite others to join.</p>
                </div>
              ) : null}
            </div>
            <button
              className="watch-new-group"
              type="button"
              disabled={disabled}
              onClick={() => {
                setView("create");
                setPassword("");
                setError(null);
              }}
            >
              <Plus size={23} aria-hidden="true" />
              <span>
                <strong>New group</strong>
                <span>Start a shared watching session</span>
              </span>
            </button>
            <p className="watch-hint">Playback stays in sync for everyone in the group.</p>
          </>
        )}
      </Modal>
    </>
  );
};
