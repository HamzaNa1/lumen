import { Button } from "@lumen/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Clapperboard,
  LockKeyhole,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Square,
  Users,
} from "lucide-react";
import { useRef, useState } from "react";
import { bridge, PageHeader, useWorkspace } from "./Workspace";
import { errorMessage } from "./format";
import "./watch-groups.css";

export const WatchGroupsPage = (): React.ReactElement => {
  const { account, scope, group } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [protectedGroup, setProtectedGroup] = useState(false);
  const [password, setPassword] = useState("");
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createKey = useRef(crypto.randomUUID());
  const queryKey = [...scope, "watch-groups"];
  const groups = useQuery({
    queryKey,
    queryFn: () => bridge.watchGroups.list(),
    refetchInterval: 5_000,
  });
  const snapshot = group?.snapshot;
  const playback = snapshot?.playback;
  const active = group !== null && group.status !== "ended";
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setCreating(false);
      setJoiningId(null);
      setPassword("");
      await queryClient.invalidateQueries({ queryKey });
    } catch (cause) {
      setError(errorMessage(cause, "Could not update the watch group"));
    } finally {
      setBusy(false);
    }
  };
  const status =
    group?.status === "blocked"
      ? "Library access needed"
      : group?.status === "reconnecting"
        ? "Reconnecting…"
        : group?.status === "failed"
          ? "Playback needs attention"
          : group?.status === "connecting"
            ? "Connecting…"
            : playback?.type === "playback"
              ? playback.state.mode === "stopped"
                ? "Ready for a movie"
                : playback.state.mode === "paused"
                  ? "Paused together"
                  : playback.state.mode === "ended"
                    ? "Playback finished"
                    : "Watching together"
              : "Synchronizing…";
  return (
    <div className="page watch-groups-page">
      <PageHeader
        title="Watch groups"
        subtitle={`A shared movie night on ${account.serverLabel}.`}
        actions={
          <Button
            disabled={active || busy}
            onClick={() => {
              setCreating(true);
              setJoiningId(null);
              setPassword("");
              setError(null);
              createKey.current = crypto.randomUUID();
            }}
          >
            <Plus size={16} aria-hidden="true" /> Create group
          </Button>
        }
      />
      {error !== null || group?.error != null ? (
        <div className="group-error" role="alert">
          {error ?? group?.error}
        </div>
      ) : null}
      {group !== null ? (
        <section className="group-current" aria-label="Your watch group">
          <div className="group-current-heading">
            <div className="group-symbol">
              <Clapperboard size={26} aria-hidden="true" />
            </div>
            <div>
              <span className="group-eyebrow">YOUR WATCH GROUP</span>
              <h2>{snapshot?.name ?? "Connecting to your group"}</h2>
            </div>
            <span className={`group-status ${group.status === "ready" ? "is-ready" : ""}`}>
              <span className="group-status-dot" />
              {status}
            </span>
          </div>
          <p className="group-explanation">
            {group.status === "blocked"
              ? "You can stay in the group, but this title isn’t in your accessible libraries. Choose a title you can play to share it with the group."
              : "Everyone can play, pause, and seek. Pick a title from your library and it starts for the group."}
          </p>
          <div className="group-members">
            {snapshot?.members.map((member) => (
              <div className="group-member" key={member.membershipId}>
                <span className="member-avatar">
                  {member.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>
                    {member.displayName}
                    {member.membershipId === snapshot.membershipId ? " (you)" : ""}
                  </strong>
                  <small>
                    {!member.connected
                      ? "Reconnecting"
                      : member.status === "ready"
                        ? "Connected"
                        : member.status === "blocked"
                          ? "Access needed"
                          : member.status === "failed"
                            ? "Playback interrupted"
                            : "Connecting"}
                  </small>
                </span>
                <span className={`member-dot ${member.connected ? "is-online" : ""}`} />
              </div>
            ))}
          </div>
          <div className="group-current-actions">
            <Button onClick={() => void navigate({ to: "/library" })} disabled={!active}>
              Choose something to watch <ArrowRight size={15} aria-hidden="true" />
            </Button>
            {playback?.type === "playback" && playback.state.media !== null ? (
              <Button
                variant="secondary"
                disabled={group.status !== "ready" || busy}
                onClick={() => void run(() => bridge.player.stop())}
              >
                <Square size={13} aria-hidden="true" /> Stop for everyone
              </Button>
            ) : null}
            {group.status === "failed" ? (
              <Button
                variant="secondary"
                onClick={() => void run(() => bridge.watchGroups.retry())}
              >
                Retry playback
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => bridge.watchGroups.leave())}
            >
              <LogOut size={15} aria-hidden="true" />
              {group.status === "ended" ? "Dismiss" : "Leave group"}
            </Button>
          </div>
          <p className="group-local-note">
            Leaving stops playback on this device. Everyone else keeps watching.
          </p>
        </section>
      ) : (
        <section className="group-intro">
          <div className="group-intro-icon">
            <Clapperboard size={32} strokeWidth={1.4} aria-hidden="true" />
            <span>
              <Users size={16} aria-hidden="true" />
            </span>
          </div>
          <div>
            <span className="group-eyebrow">BETTER TOGETHER</span>
            <h2>Same moment. Wherever you are.</h2>
            <p>
              Start a group, choose a film, and settle in. Playback stays in sync, with everyone
              sharing the controls.
            </p>
          </div>
        </section>
      )}
      {creating || joiningId !== null ? (
        <form
          className="group-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() =>
              creating
                ? bridge.watchGroups.create({
                    name: name.trim(),
                    idempotencyKey: createKey.current,
                    ...(protectedGroup ? { password } : {}),
                  })
                : bridge.watchGroups.join(joiningId ?? "", password),
            );
          }}
        >
          <div>
            <h2>{creating ? "Create a watch group" : "Join protected group"}</h2>
            <p>
              {creating
                ? "Give tonight’s gathering a name."
                : "Enter the password shared by someone in this group."}
            </p>
          </div>
          {creating ? (
            <label>
              Group name
              <input
                autoComplete="off"
                maxLength={80}
                required
                value={name}
                placeholder="Friday movie night"
                onChange={(event) => {
                  setName(event.target.value);
                  createKey.current = crypto.randomUUID();
                }}
              />
            </label>
          ) : null}
          {creating ? (
            <label className="group-checkbox">
              <input
                type="checkbox"
                checked={protectedGroup}
                onChange={(event) => {
                  setProtectedGroup(event.target.checked);
                  createKey.current = crypto.randomUUID();
                }}
              />{" "}
              Require a password
            </label>
          ) : null}
          {protectedGroup || !creating ? (
            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                maxLength={256}
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  createKey.current = crypto.randomUUID();
                }}
              />
            </label>
          ) : null}
          <div className="group-form-actions">
            <Button type="submit" disabled={busy || (creating && name.trim().length === 0)}>
              {busy ? "Connecting…" : creating ? "Create group" : "Join group"}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setJoiningId(null);
                setPassword("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <section className="group-directory" aria-label="Available watch groups">
        <div className="group-section-heading">
          <h2>
            On this server <span>{groups.data?.groups.length ?? 0}</span>
          </h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={groups.isFetching}
            onClick={() => void groups.refetch()}
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </Button>
        </div>
        {groups.isPending ? (
          <p role="status">Finding watch groups…</p>
        ) : groups.isError ? (
          <div className="group-error" role="alert">
            Groups couldn’t be loaded. Check the server connection and refresh.
          </div>
        ) : groups.data.groups.length === 0 ? (
          <div className="group-empty">
            <Users size={28} strokeWidth={1.3} aria-hidden="true" />
            <h3>The room is yours.</h3>
            <p>No groups yet. Create one and invite someone on this server to join.</p>
          </div>
        ) : (
          <div className="group-grid">
            {groups.data.groups.map((entry) => (
              <article className="group-card" key={entry.groupId}>
                <div className="group-card-top">
                  <span className="group-card-icon">
                    <Clapperboard size={21} strokeWidth={1.5} aria-hidden="true" />
                  </span>
                  <span className="group-privacy">
                    {entry.passwordRequired ? (
                      <>
                        <LockKeyhole size={12} aria-hidden="true" /> Password
                      </>
                    ) : (
                      <>
                        <Radio size={12} aria-hidden="true" /> Open group
                      </>
                    )}
                  </span>
                </div>
                <h3>{entry.name}</h3>
                <p>
                  <Users size={14} aria-hidden="true" /> {entry.memberCount}{" "}
                  {entry.memberCount === 1 ? "member" : "members"}
                </p>
                <Button
                  variant="secondary"
                  disabled={active || busy || entry.memberCount >= 32}
                  onClick={() => {
                    if (entry.passwordRequired) {
                      setCreating(false);
                      setJoiningId(entry.groupId);
                      setPassword("");
                      setError(null);
                    } else void run(() => bridge.watchGroups.join(entry.groupId));
                  }}
                >
                  {entry.groupId === snapshot?.groupId
                    ? "You’re in this group"
                    : entry.memberCount >= 32
                      ? "Group full"
                      : "Join group"}
                  {entry.groupId !== snapshot?.groupId ? (
                    <ArrowRight size={14} aria-hidden="true" />
                  ) : null}
                </Button>
              </article>
            ))}
          </div>
        )}
      </section>
      <div className="group-footnote">
        <ShieldCheck size={16} aria-hidden="true" />
        <p>Only signed-in members of this server can join. Your library permissions still apply.</p>
      </div>
    </div>
  );
};
