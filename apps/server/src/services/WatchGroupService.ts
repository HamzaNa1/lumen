import {
  type CreateWatchGroup,
  type WatchGroup,
  type WatchGroupCommand,
  type WatchGroupSnapshot,
  type WatchGroupSummary,
  watchGroupPosition,
} from "@lumen/contracts";
import { badRequest, conflict, forbidden, notFound } from "../core/Errors";
import { hashPassword, newUuid, verifyPassword } from "../core/Security";
import type { AuthPrincipal } from "./AuthService";

interface Member {
  readonly principal: AuthPrincipal;
  lastSeenAtMs: number;
}
interface Group {
  state: WatchGroup;
  readonly passwordHash: string | null;
  readonly members: Map<string, Member>;
  readonly listeners: Set<() => void>;
}
type AuthorizeMedia = (
  principal: AuthPrincipal,
  itemId: string,
) => Promise<{
  title: string;
  durationSeconds: number | null;
}>;

// Groups belong to the live server session; restarting the server ends them.
export class WatchGroupService {
  private readonly groups = new Map<string, Group>();

  constructor(private readonly authorizeMedia: AuthorizeMedia) {}

  list(): ReadonlyArray<WatchGroupSummary> {
    this.sweep();
    return Array.from(this.groups.values(), ({ state }) => ({
      id: state.id,
      name: state.name,
      passwordProtected: state.passwordProtected,
      members: state.members,
    }));
  }

  async create(principal: AuthPrincipal, input: CreateWatchGroup): Promise<WatchGroupSnapshot> {
    const name = input.name.trim();
    if (name.length === 0) throw badRequest("Enter a group name");
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    this.sweep();
    if (this.membership(principal) !== undefined) throw conflict("Leave your current group first");
    if (this.groups.size >= 256) throw conflict("Too many watch groups; try again later");
    const group: Group = {
      state: {
        id: newUuid(),
        name,
        passwordProtected: passwordHash !== null,
        members: [],
        revision: 0,
        playback: null,
      },
      passwordHash,
      members: new Map(),
      listeners: new Set(),
    };
    this.groups.set(group.state.id, group);
    this.addMember(group, principal);
    return this.snapshot(group);
  }

  async join(
    principal: AuthPrincipal,
    groupId: string,
    password = "",
  ): Promise<WatchGroupSnapshot> {
    this.sweep();
    const group = this.requireGroup(groupId);
    if (this.membership(principal) === group)
      return this.snapshot(this.requireMember(principal, groupId));
    if (group.passwordHash !== null && !(await verifyPassword(password, group.passwordHash)))
      throw forbidden("Incorrect group password");
    const itemId = group.state.playback?.itemId;
    if (itemId !== undefined) await this.authorizeMedia(principal, itemId);
    this.sweep();
    this.requireGroup(groupId);
    if (group.state.playback?.itemId !== itemId)
      throw conflict("Group playback changed; try joining again");
    const current = this.membership(principal);
    if (current === group) return this.snapshot(this.requireMember(principal, groupId));
    if (current !== undefined) throw conflict("Leave your current group first");
    if (group.members.size >= 64) throw conflict("This group is full");
    this.addMember(group, principal);
    return this.snapshot(group);
  }

  async leave(principal: AuthPrincipal, groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (group === undefined || !group.members.has(this.memberId(principal))) return;
    this.requireMember(principal, groupId);
    group.members.delete(this.memberId(principal));
    this.changedMembers(group);
  }

  async read(
    principal: AuthPrincipal,
    groupId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<WatchGroupSnapshot> {
    this.sweep();
    const group = this.requireMember(principal, groupId);
    const member = group.members.get(this.memberId(principal));
    if (member !== undefined) member.lastSeenAtMs = Date.now();
    if (group.state.revision === revision && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          group.listeners.delete(done);
          resolve();
        };
        const timer = setTimeout(done, 8_000);
        group.listeners.add(done);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    this.requireMember(principal, groupId);
    return this.snapshot(group);
  }

  async command(
    principal: AuthPrincipal,
    groupId: string,
    command: WatchGroupCommand,
  ): Promise<WatchGroupSnapshot> {
    this.sweep();
    const group = this.requireMember(principal, groupId);
    const member = group.members.get(this.memberId(principal));
    if (member !== undefined) member.lastSeenAtMs = Date.now();
    if (command.type === "start") {
      const expectedRevision = group.state.revision;
      const members = Array.from(group.members.values());
      const media = await this.authorizeMedia(principal, command.itemId);
      for (const member of members) {
        if (member.principal.deviceId !== principal.deviceId)
          await this.authorizeMedia(member.principal, command.itemId);
      }
      this.sweep();
      this.requireMember(principal, groupId);
      if (group.state.revision !== expectedRevision)
        throw conflict("Group changed while preparing playback; try again");
      if (media.durationSeconds !== null && command.positionSeconds > media.durationSeconds)
        throw badRequest("Position exceeds duration");
      const revision = group.state.revision + 1;
      group.state = {
        ...group.state,
        revision,
        playback: {
          id: newUuid(),
          itemId: command.itemId,
          title: media.title,
          durationSeconds: media.durationSeconds,
          positionSeconds: command.positionSeconds,
          paused: false,
          updatedAtMs: Date.now(),
          revision,
        },
      };
    } else {
      const playback = group.state.playback;
      if (playback === null || playback.id !== command.playbackId)
        throw conflict("Group playback changed; try again");
      const now = Date.now();
      if (
        command.type === "seek" &&
        playback.durationSeconds !== null &&
        command.positionSeconds > playback.durationSeconds
      )
        throw badRequest("Position exceeds duration");
      const revision = group.state.revision + 1;
      group.state = {
        ...group.state,
        revision,
        playback:
          command.type === "stop"
            ? null
            : {
                ...playback,
                revision,
                updatedAtMs: now,
                positionSeconds:
                  command.type === "seek"
                    ? command.positionSeconds
                    : watchGroupPosition(playback, now),
                paused:
                  command.type === "pause"
                    ? true
                    : command.type === "resume"
                      ? false
                      : playback.paused,
              },
      };
    }
    this.notify(group);
    return this.snapshot(group);
  }

  private memberId(principal: AuthPrincipal): string {
    return principal.deviceId;
  }
  private membership(principal: AuthPrincipal): Group | undefined {
    return Array.from(this.groups.values()).find((group) =>
      group.members.has(this.memberId(principal)),
    );
  }
  private requireGroup(id: string): Group {
    const group = this.groups.get(id);
    if (group === undefined) throw notFound("Watch group has ended");
    return group;
  }
  private requireMember(principal: AuthPrincipal, id: string): Group {
    const group = this.requireGroup(id);
    const member = group.members.get(this.memberId(principal));
    if (
      member === undefined ||
      member.principal.user.id !== principal.user.id ||
      member.principal.sessionId !== principal.sessionId
    )
      throw forbidden("Join this watch group first");
    return group;
  }
  private addMember(group: Group, principal: AuthPrincipal): void {
    group.members.set(this.memberId(principal), { principal, lastSeenAtMs: Date.now() });
    this.changedMembers(group);
  }
  private changedMembers(group: Group): void {
    group.state = {
      ...group.state,
      revision: group.state.revision + 1,
      members: Array.from(group.members.values(), ({ principal }) => ({
        id: this.memberId(principal),
        displayName: principal.user.displayName,
      })),
    };
    if (group.members.size === 0) this.groups.delete(group.state.id);
    this.notify(group);
  }
  private notify(group: Group): void {
    for (const listener of group.listeners) listener();
  }
  private snapshot(group: Group): WatchGroupSnapshot {
    return { group: group.state, serverTimeMs: Date.now() };
  }
  private sweep(): void {
    const cutoff = Date.now() - 45_000;
    for (const group of this.groups.values()) {
      let changed = false;
      for (const [id, member] of group.members) {
        if (member.lastSeenAtMs < cutoff) {
          group.members.delete(id);
          changed = true;
        }
      }
      if (changed) this.changedMembers(group);
    }
  }
}
