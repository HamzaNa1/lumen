import {
  initialWatchStatus,
  type WatchAction,
  type WatchGroup,
  type WatchPlayback,
  type WatchStatus,
} from "@lumen/contracts";
import { Avatar, Button, formatPlayerTime, Popover, PopoverTitle, TextField } from "@lumen/ui";
import { CircleAlert, LoaderCircle, Lock, LogOut, Pause, Play, Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "./format";
import { useRuntime } from "./Runtime";
import "./watch-groups.css";

const visibleMemberNames = 3;

const playbackSummary = (playback: WatchPlayback | null): string =>
  playback === null
    ? "Nothing playing"
    : playback.paused
      ? `Paused on ${playback.title}`
      : `Watching ${playback.title}`;

const memberNames = (members: WatchGroup["members"]): string => {
  if (members.length === 0) return "Empty";
  const names = members
    .slice(0, visibleMemberNames)
    .map((member) => member.displayName)
    .join(", ");
  return members.length > visibleMemberNames
    ? `${names} +${members.length - visibleMemberNames}`
    : names;
};

const peopleCount = (count: number): string => (count === 1 ? "1 person" : `${count} people`);

const PanelHeader = ({
  title,
  locked = false,
  connection,
}: {
  readonly title: string;
  readonly locked?: boolean;
  readonly connection: WatchStatus["connection"];
}): React.ReactElement => (
  <header className="watch-group-header">
    <PopoverTitle>{title}</PopoverTitle>
    {locked ? <Lock aria-label="Password protected" size={13} /> : null}
    {connection === "connected" ? null : (
      <span className="watch-group-connection" role="status">
        <LoaderCircle className="spinner" aria-hidden="true" size={13} />
        {connection === "connecting" ? "Connecting…" : "Reconnecting…"}
      </span>
    )}
  </header>
);

const GroupList = ({
  groups,
  connected,
  disabled,
  onJoin,
  onCreate,
}: {
  readonly groups: ReadonlyArray<WatchGroup>;
  readonly connected: boolean;
  readonly disabled: boolean;
  readonly onJoin: (groupId: string, password: string) => void;
  readonly onCreate: () => void;
}): React.ReactElement => {
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  return (
    <>
      {groups.length > 0 ? (
        <ul className="watch-group-list">
          {groups.map((group) => {
            const unlocking = unlockingId === group.id;
            return (
              <li key={group.id}>
                <button
                  className="watch-group-row"
                  type="button"
                  disabled={disabled}
                  aria-expanded={group.hasPassword ? unlocking : undefined}
                  onClick={() => {
                    if (!group.hasPassword) onJoin(group.id, "");
                    else {
                      setPassword("");
                      setUnlockingId(unlocking ? null : group.id);
                    }
                  }}
                >
                  <span className="watch-group-row-text">
                    <strong>
                      <span>{group.name}</span>
                      {group.hasPassword ? (
                        <Lock aria-label="Password protected" size={12} />
                      ) : null}
                    </strong>
                    <span>
                      {memberNames(group.members)}
                      {group.playback === null ? null : ` · ${playbackSummary(group.playback)}`}
                    </span>
                  </span>
                  {unlocking ? null : <span className="watch-group-row-action">Join</span>}
                </button>
                {unlocking ? (
                  <form
                    className="watch-group-unlock"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onJoin(group.id, password);
                    }}
                  >
                    <TextField
                      label={`Password for ${group.name}`}
                      hideLabel
                      type="password"
                      placeholder="Password"
                      autoComplete="off"
                      autoFocus
                      required
                      maxLength={128}
                      value={password}
                      onValueChange={setPassword}
                    />
                    <Button type="submit" variant="primary" disabled={disabled || password === ""}>
                      Join
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : connected ? (
        <div className="watch-group-empty">
          <strong>No groups yet</strong>
          <p>Start one and anyone on this server can join.</p>
        </div>
      ) : null}
      <footer className="watch-group-footer">
        <Button className="button-wide" disabled={disabled} onClick={onCreate}>
          <Plus aria-hidden="true" size={15} />
          New group
        </Button>
      </footer>
    </>
  );
};

const CreateGroupForm = ({
  disabled,
  onCreate,
  onCancel,
}: {
  readonly disabled: boolean;
  readonly onCreate: (name: string, password: string) => void;
  readonly onCancel: () => void;
}): React.ReactElement => {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className="watch-group-form"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(name.trim(), password);
      }}
    >
      <TextField
        label="Name"
        placeholder="Movie night"
        autoFocus
        required
        maxLength={80}
        value={name}
        onValueChange={setName}
      />
      <TextField
        label="Password"
        description="Optional. Leave empty to let anyone join."
        type="password"
        autoComplete="new-password"
        maxLength={128}
        value={password}
        onValueChange={setPassword}
      />
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={disabled || name.trim() === ""}>
          Create group
        </Button>
      </div>
    </form>
  );
};

const ActiveGroup = ({
  group,
  memberId,
  disabled,
  onLeave,
}: {
  readonly group: WatchGroup;
  readonly memberId: string | null;
  readonly disabled: boolean;
  readonly onLeave: () => void;
}): React.ReactElement => {
  const playback = group.playback;
  const playing = playback !== null && !playback.paused;
  return (
    <>
      <div className={`watch-group-now${playing ? " is-playing" : ""}`}>
        <span className="watch-group-now-icon">
          {playback?.paused ? (
            <Pause aria-hidden="true" size={15} fill="currentColor" />
          ) : (
            <Play aria-hidden="true" size={15} fill="currentColor" />
          )}
        </span>
        <span className="watch-group-now-text">
          <strong>{playback?.title ?? "Nothing playing"}</strong>
          <span>
            {playback === null
              ? "Play a movie or episode and it starts for everyone."
              : playback.paused
                ? `Paused at ${formatPlayerTime(playback.positionSeconds)}`
                : "Playing for everyone"}
          </span>
        </span>
      </div>
      <h3 className="watch-group-label">{peopleCount(group.members.length)}</h3>
      <ul className="watch-group-members">
        {group.members.map((member) => (
          <li key={member.id}>
            <Avatar name={member.displayName} size="sm" />
            <span>{member.displayName}</span>
            {member.id === memberId ? <small>You</small> : null}
          </li>
        ))}
      </ul>
      <footer className="watch-group-footer">
        <p>Playback controls are shared.</p>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onLeave}>
          <LogOut aria-hidden="true" size={14} />
          Leave
        </Button>
      </footer>
    </>
  );
};

export const WatchGroups = ({
  placement,
}: {
  readonly placement: "sidebar" | "player";
}): React.ReactElement | null => {
  const runtime = useRuntime();
  const [status, setStatus] = useState(initialWatchStatus);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const unsubscribe = runtime.watch.onState(setStatus);
    void runtime.watch
      .state()
      .then(setStatus)
      .catch(() => undefined);
    return unsubscribe;
  }, [runtime]);
  const perform = async (action: WatchAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await runtime.watch.action(action));
      setCreating(false);
    } catch (cause) {
      setError(errorMessage(cause, "Could not update the group"));
    } finally {
      setBusy(false);
    }
  };
  const changeOpen = (next: boolean): void => {
    setOpen(next);
    setCreating(false);
    setError(null);
    if (next)
      void runtime.watch
        .state()
        .then(setStatus)
        .catch((cause: unknown) => setError(errorMessage(cause, "Could not connect")));
  };
  if (status.connection === "unavailable") return null;
  const group = status.group;
  const connected = status.connection === "connected";
  const disabled = busy || !connected;
  const visibleError = error ?? status.error;
  return (
    <Popover
      open={open}
      onOpenChange={changeOpen}
      side={placement === "sidebar" ? "top" : "bottom"}
      align={placement === "sidebar" ? "start" : "end"}
      className="watch-group-panel"
      trigger={
        placement === "sidebar" ? (
          <button
            type="button"
            className={`watch-group-trigger${group === null ? "" : " is-active"}`}
          >
            <Users aria-hidden="true" size={16} strokeWidth={1.85} />
            <span className="watch-group-trigger-text">
              <strong>{group?.name ?? "Watch together"}</strong>
              {group === null ? null : (
                <span>{connected ? playbackSummary(group.playback) : "Reconnecting…"}</span>
              )}
            </span>
            {group === null ? null : (
              <span className="watch-group-trigger-count">{group.members.length}</span>
            )}
          </button>
        ) : (
          <Button
            variant="icon"
            className={`watch-group-chip${group === null ? "" : " is-active"}`}
            aria-label={
              group === null
                ? "Watch together"
                : `${group.name}, ${peopleCount(group.members.length)}`
            }
          >
            <Users aria-hidden="true" size={19} />
            {group === null ? null : <span>{group.members.length}</span>}
          </Button>
        )
      }
    >
      <PanelHeader
        title={group?.name ?? (creating ? "New group" : "Watch together")}
        locked={group?.hasPassword}
        connection={status.connection}
      />
      {visibleError === null ? null : (
        <p className="form-error watch-group-error" role="alert">
          <CircleAlert aria-hidden="true" size={15} />
          {visibleError}
        </p>
      )}
      {group !== null ? (
        <ActiveGroup
          group={group}
          memberId={status.memberId}
          disabled={disabled}
          onLeave={() => void perform({ type: "leave" })}
        />
      ) : creating ? (
        <CreateGroupForm
          disabled={disabled}
          onCreate={(name, password) => void perform({ type: "create", name, password })}
          onCancel={() => {
            setCreating(false);
            setError(null);
          }}
        />
      ) : (
        <GroupList
          groups={status.groups}
          connected={connected}
          disabled={disabled}
          onJoin={(groupId, password) => void perform({ type: "join", groupId, password })}
          onCreate={() => {
            setCreating(true);
            setError(null);
          }}
        />
      )}
    </Popover>
  );
};
