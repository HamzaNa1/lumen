import {
  watchGroupScheduler,
  type WatchGroupScheduler,
  type CancelScheduled,
} from "@lumen/contracts";
import {
  type CreateWatchGroup,
  type GroupCommand,
  type GroupCommandResult,
  type GroupErrorCode,
  type GroupList,
  type GroupMedia,
  type GroupMemberStatus,
  type GroupPlayback,
  type GroupServerFrame,
  type GroupSnapshot,
  positionAt,
} from "@lumen/contracts";
import type { AuthPrincipal } from "../../services/AuthService";
import type { PlaybackStartResponse } from "../../services/PlaybackService";
import { hashPassword, hashToken, newUuid, verifyPassword } from "../../core/Security";
import { ServerError } from "../../core/Errors";
import { ConnectionTickets } from "./ConnectionTickets";
import { GroupFailure } from "./GroupFailure";
import { GroupQueue } from "./GroupQueue";
import { initialPlayback, transition, type PreparedAction } from "./GroupState";
import { TokenBucket, type WatchGroupLimits } from "./WatchGroupLimits";

export interface GroupPeer {
  readonly id: string;
  send(frame: GroupServerFrame): void;
  close(code: GroupErrorCode): void;
}
interface CachedResult {
  readonly fingerprint: string;
  readonly outcome: GroupCommandResult["outcome"];
  readonly code: GroupErrorCode | null;
  readonly revision: number;
  readonly at: number;
}
interface Member {
  readonly id: string;
  principal: AuthPrincipal;
  peer: GroupPeer | null;
  disconnectedAt: number | null;
  status: GroupMemberStatus;
  readonly controls: TokenBucket;
  readonly results: Map<string, CachedResult>;
}
interface Room {
  readonly id: string;
  readonly name: string;
  readonly passwordHash: string | null;
  readonly queue: GroupQueue;
  readonly members: Map<string, Member>;
  readonly controls: TokenBucket;
  playback: GroupPlayback;
  rosterRevision: number;
  emptySince: number | null;
  endTimer: CancelScheduled | null;
  maintenancePending: boolean;
  lastRefresh: number;
}
export interface GroupRegistryDependencies {
  readonly scheduler?: WatchGroupScheduler;
  readonly limits: WatchGroupLimits;
  readonly now: () => number;
  readonly validate: (principal: AuthPrincipal) => Promise<AuthPrincipal>;
  readonly resolve: (
    principal: AuthPrincipal,
    itemId: string,
    exact?: GroupMedia,
  ) => Promise<GroupMedia>;
  readonly canPlay: (principal: AuthPrincipal, media: GroupMedia) => Promise<boolean>;
  readonly startSession: (
    principal: AuthPrincipal,
    media: GroupMedia,
  ) => Promise<PlaybackStartResponse>;
  readonly closeSession: (principal: AuthPrincipal, sessionId: string) => Promise<void>;
  readonly log: (event: string, fields: Record<string, string | number>) => void;
}
export class GroupRegistry {
  readonly serverInstanceId = newUuid();
  readonly tickets: ConnectionTickets;
  private readonly rooms = new Map<string, Room>();
  private readonly devices = new Map<string, { roomId: string; memberId: string }>();
  private readonly membershipQueue: GroupQueue;
  private readonly attempts = new Map<string, { bucket: TokenBucket; at: number }>();
  private readonly creations = new Map<
    string,
    { fingerprint: string; roomId: string; at: number }
  >();
  private hashes = 0;
  private disposed = false;
  constructor(private readonly deps: GroupRegistryDependencies) {
    this.membershipQueue = new GroupQueue(deps.limits.queue);
    this.tickets = new ConnectionTickets(deps.limits.tickets, deps.limits.ticketTtlMs, deps.now);
  }
  list(limit: number, cursor: string | null): GroupList {
    const rooms = [...this.rooms.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((room) => cursor === null || room.id > cursor);
    const page = rooms.slice(0, limit);
    return {
      groups: page.map((r) => ({
        groupId: r.id,
        name: r.name,
        memberCount: r.members.size,
        passwordRequired: r.passwordHash !== null,
      })),
      nextCursor: rooms.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
  async create(principal: AuthPrincipal, input: CreateWatchGroup): Promise<GroupSnapshot> {
    this.limitJoin(principal);
    // Reserve expensive work before enqueueing so bursts cannot retain password closures indefinitely.
    return this.passwordWork(async () => {
      const passwordHash = input.password === undefined ? null : await hashPassword(input.password);
      return this.membershipQueue.run(async () => {
        principal = await this.deps.validate(principal);
        const key = `${principal.sessionId}:${input.idempotencyKey}`;
        const fingerprint = hashToken(JSON.stringify(input));
        const previous = this.creations.get(key);
        if (
          previous !== undefined &&
          this.deps.now() - previous.at < this.deps.limits.resultTtlMs
        ) {
          if (previous.fingerprint !== fingerprint)
            throw new GroupFailure(
              "invalid_command",
              "Idempotency key was reused with different content",
            );
          return this.state(principal, previous.roomId);
        }
        this.requireNoMembership(principal);
        if (this.rooms.size >= this.deps.limits.groups)
          throw new GroupFailure("capacity", "The server has reached its watch group limit");
        const id = newUuid();
        const now = this.deps.now();
        const room: Room = {
          id,
          name: input.name.trim(),
          passwordHash,
          queue: new GroupQueue(this.deps.limits.queue),
          members: new Map(),
          controls: new TokenBucket(
            this.deps.limits.roomControlsPerSecond,
            this.deps.limits.roomControlBurst,
            now,
          ),
          playback: initialPlayback(this.serverInstanceId, id, newUuid(), now),
          rosterRevision: 0,
          emptySince: now,
          endTimer: null,
          maintenancePending: false,
          lastRefresh: now,
        };
        this.rooms.set(id, room);
        const member = this.addMember(room, principal);
        this.creations.set(key, { fingerprint, roomId: id, at: now });
        this.trim(this.creations, this.deps.limits.rateKeys);
        return this.snapshot(room, member);
      });
    }, input.password !== undefined);
  }
  async join(principal: AuthPrincipal, roomId: string, password?: string): Promise<GroupSnapshot> {
    this.limitJoin(principal);
    const room = this.room(roomId);
    const existing = this.findMember(room, principal);
    if (existing !== undefined) return this.state(principal, roomId);
    const valid =
      room.passwordHash === null ||
      (await this.passwordWork(
        () => verifyPassword(password ?? "", room.passwordHash as string),
        true,
      ));
    if (!valid) throw new GroupFailure("denied", "Incorrect watch group password");
    return this.membershipQueue.run(() =>
      room.queue.run(async () => {
        principal = await this.deps.validate(principal);
        this.room(roomId);
        const previous = this.findMember(room, principal);
        if (previous !== undefined) return this.snapshot(room, previous);
        this.requireNoMembership(principal);
        if (room.members.size >= this.deps.limits.members)
          throw new GroupFailure("capacity", "This watch group is full");
        const member = this.addMember(room, principal);
        await this.broadcast(room);
        return this.snapshot(room, member);
      }),
    );
  }
  leave(principal: AuthPrincipal, roomId: string): Promise<void> {
    const room = this.room(roomId);
    return this.membershipQueue.run(() =>
      room.queue.run(async () => {
        const member = this.findMember(room, principal);
        if (member === undefined) return;
        this.removeMember(room, member, "membership_expired");
        this.freezeEmpty(room);
        await this.broadcast(room);
      }),
    );
  }
  state(principal: AuthPrincipal, roomId: string): Promise<GroupSnapshot> {
    const room = this.room(roomId);
    return room.queue.run(async () => this.snapshot(room, await this.liveMember(room, principal)));
  }
  ticket(
    principal: AuthPrincipal,
    roomId: string,
  ): Promise<{ ticket: string; serverInstanceId: string }> {
    const room = this.room(roomId);
    return room.queue.run(async () => {
      const member = await this.liveMember(room, principal);
      return {
        ticket: this.tickets.issue({
          serverInstanceId: this.serverInstanceId,
          groupId: roomId,
          membershipId: member.id,
          userId: principal.user.id,
          deviceId: principal.deviceId,
          sessionId: principal.sessionId,
        }),
        serverInstanceId: this.serverInstanceId,
      };
    });
  }
  async attach(token: string, peer: GroupPeer): Promise<{ groupId: string; membershipId: string }> {
    const binding = this.tickets.consume(token);
    if (binding.serverInstanceId !== this.serverInstanceId)
      throw new GroupFailure("server_restarted", "Server restarted");
    const room = this.room(binding.groupId);
    return room.queue.run(async () => {
      const member = room.members.get(binding.membershipId);
      if (
        member === undefined ||
        member.principal.sessionId !== binding.sessionId ||
        member.principal.deviceId !== binding.deviceId ||
        member.principal.user.id !== binding.userId
      )
        throw new GroupFailure("membership_expired", "Membership expired");
      await this.liveMember(room, member.principal);
      const old = member.peer;
      member.peer = peer;
      member.disconnectedAt = null;
      member.status = "connecting";
      room.emptySince = null;
      room.rosterRevision++;
      old?.close("membership_expired");
      await this.broadcast(room);
      return { groupId: room.id, membershipId: member.id };
    });
  }
  detach(roomId: string, memberId: string, peerId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room === undefined || this.disposed) return Promise.resolve();
    return room.queue.run(async () => {
      const member = room.members.get(memberId);
      if (member?.peer?.id !== peerId) return;
      member.peer = null;
      member.disconnectedAt = this.deps.now();
      room.rosterRevision++;
      this.freezeEmpty(room);
      await this.broadcast(room);
    });
  }
  refresh(
    roomId: string,
    memberId: string,
    peerId: string,
    status?: GroupMemberStatus,
  ): Promise<void> {
    const room = this.room(roomId);
    return room.queue.run(async () => {
      const member = this.connectedMember(room, memberId, peerId);
      await this.liveMember(room, member.principal);
      if (status !== undefined && member.status !== status) {
        member.status = status;
        room.rosterRevision++;
      }
      member.peer?.send({
        protocolVersion: 1,
        type: "snapshot",
        snapshot: await this.snapshot(room, member),
      });
    });
  }
  command(
    roomId: string,
    memberId: string,
    peerId: string,
    command: GroupCommand,
  ): Promise<GroupCommandResult> {
    const room = this.room(roomId);
    const member = this.connectedMember(room, memberId, peerId);
    if (!member.controls.take(this.deps.now()) || !room.controls.take(this.deps.now()))
      throw new GroupFailure("rate_limited", "Too many playback controls");
    return room.queue.run(async () => {
      this.connectedMember(room, memberId, peerId);
      await this.liveMember(room, member.principal);
      const fingerprint = JSON.stringify(command);
      const cached = member.results.get(command.commandId);
      if (cached !== undefined && this.deps.now() - cached.at <= this.deps.limits.resultTtlMs) {
        if (cached.fingerprint !== fingerprint)
          return this.result(
            room,
            member,
            command,
            "rejected",
            "invalid_command",
            room.playback.revision,
          );
        return this.result(room, member, command, cached.outcome, cached.code, cached.revision);
      }
      let code: GroupErrorCode | null = null;
      if (
        command.expectedRevision !== room.playback.revision ||
        command.expectedPlaybackId !== room.playback.playbackId
      )
        code = "stale_state";
      else {
        try {
          const action = command.action;
          let prepared: PreparedAction;
          if (action.type === "start") {
            const media = await this.deps.resolve(member.principal, action.itemId);
            prepared = { ...action, media, playbackId: newUuid() };
          } else {
            if (
              room.playback.media !== null &&
              !(await this.deps.canPlay(member.principal, room.playback.media))
            )
              throw new GroupFailure("denied", "Playback access denied");
            prepared = action.type === "stop" ? { type: "stop", playbackId: newUuid() } : action;
          }
          // All awaits precede the synchronous transition and deduplication record.
          room.playback = transition(room.playback, prepared, this.deps.now());
          this.scheduleEnd(room);
        } catch (error) {
          code = this.errorCode(error);
        }
      }
      const outcome = code === null ? "accepted" : "rejected";
      const revision = room.playback.revision;
      member.results.set(command.commandId, {
        fingerprint,
        outcome,
        code,
        revision,
        at: this.deps.now(),
      });
      this.trim(member.results, this.deps.limits.resultsPerMember);
      this.deps.log("watch_group_command", {
        groupId: room.id,
        commandId: command.commandId,
        outcome,
        reason: code ?? "accepted",
        revision,
      });
      if (code === null) await this.broadcast(room);
      return this.result(room, member, command, outcome, code, revision);
    });
  }
  async playbackSession(
    principal: AuthPrincipal,
    roomId: string,
    expectedPlaybackId: string,
  ): Promise<PlaybackStartResponse> {
    const room = this.room(roomId);
    const media = await room.queue.run(async () => {
      const member = await this.liveMember(room, principal);
      if (room.playback.playbackId !== expectedPlaybackId || room.playback.media === null)
        throw new GroupFailure("stale_state", "Playback changed; refresh the group");
      if (!(await this.deps.canPlay(member.principal, room.playback.media)))
        throw new GroupFailure("denied", "Playback access denied");
      return room.playback.media;
    });
    const session = await this.deps.startSession(principal, media);
    try {
      await room.queue.run(async () => {
        await this.liveMember(room, principal);
        if (room.playback.playbackId !== expectedPlaybackId)
          throw new GroupFailure("stale_state", "Playback changed; refresh the group");
        await this.deps.resolve(principal, media.itemId, media);
      });
      return session;
    } catch (error) {
      await this.deps.closeSession(principal, session.session.id);
      throw error;
    }
  }
  async sweep(): Promise<void> {
    if (this.disposed) return;
    const now = this.deps.now();
    this.tickets.sweep();
    for (const [key, entry] of this.attempts)
      if (now - entry.at > 60_000) this.attempts.delete(key);
    for (const [key, entry] of this.creations)
      if (now - entry.at > this.deps.limits.resultTtlMs) this.creations.delete(key);
    await Promise.all(
      [...this.rooms.values()].map(async (room) => {
        if (room.maintenancePending) return;
        room.maintenancePending = true;
        try {
          await room.queue.run(async () => {
            for (const member of room.members.values()) {
              for (const [id, result] of member.results)
                if (now - result.at > this.deps.limits.resultTtlMs) member.results.delete(id);
              if (
                member.disconnectedAt !== null &&
                now - member.disconnectedAt >= this.deps.limits.reconnectGraceMs
              )
                this.removeMember(room, member, "membership_expired");
            }
            this.freezeEmpty(room);
            if (
              room.emptySince !== null &&
              now - room.emptySince >= this.deps.limits.emptyExpiryMs
            ) {
              for (const member of room.members.values())
                this.removeMember(room, member, "membership_expired");
              this.rooms.delete(room.id);
              room.endTimer?.();
              room.queue.close();
            } else if (now - room.lastRefresh >= this.deps.limits.refreshMs) {
              room.lastRefresh = now;
              await this.broadcast(room);
            }
          });
        } catch (error) {
          this.deps.log("watch_group_maintenance_failed", {
            groupId: room.id,
            reason: this.errorCode(error),
          });
        } finally {
          room.maintenancePending = false;
        }
      }),
    );
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.membershipQueue.close();
    this.tickets.clear();
    for (const room of this.rooms.values()) {
      room.queue.close();
      room.endTimer?.();
      for (const member of room.members.values()) member.peer?.close("unavailable");
    }
    await Promise.all([
      this.membershipQueue.idle(),
      ...[...this.rooms.values()].map((room) => room.queue.idle()),
    ]);
    this.rooms.clear();
    this.devices.clear();
    this.attempts.clear();
    this.creations.clear();
  }
  private room(id: string): Room {
    const room = this.rooms.get(id);
    if (room === undefined || this.disposed)
      throw new GroupFailure(
        "membership_expired",
        "Watch group no longer exists; join another group",
      );
    return room;
  }
  private findMember(room: Room, principal: AuthPrincipal): Member | undefined {
    return [...room.members.values()].find(
      (m) =>
        m.principal.sessionId === principal.sessionId &&
        m.principal.deviceId === principal.deviceId &&
        m.principal.user.id === principal.user.id,
    );
  }
  private async liveMember(room: Room, principal: AuthPrincipal): Promise<Member> {
    const member = this.findMember(room, principal);
    if (
      member === undefined ||
      (member.disconnectedAt !== null &&
        this.deps.now() - member.disconnectedAt >= this.deps.limits.reconnectGraceMs)
    )
      throw new GroupFailure("membership_expired", "Membership expired; join again");
    member.principal = await this.deps.validate(principal);
    return member;
  }
  private connectedMember(room: Room, id: string, peerId: string): Member {
    const member = room.members.get(id);
    if (member === undefined || member.peer?.id !== peerId)
      throw new GroupFailure("membership_expired", "Connection was replaced or membership expired");
    return member;
  }
  private addMember(room: Room, principal: AuthPrincipal): Member {
    const member: Member = {
      id: newUuid(),
      principal,
      peer: null,
      disconnectedAt: this.deps.now(),
      status: "connecting",
      controls: new TokenBucket(
        this.deps.limits.controlsPerSecond,
        this.deps.limits.controlBurst,
        this.deps.now(),
      ),
      results: new Map(),
    };
    room.members.set(member.id, member);
    room.rosterRevision++;
    this.devices.set(principal.deviceId, { roomId: room.id, memberId: member.id });
    return member;
  }
  private removeMember(room: Room, member: Member, code: GroupErrorCode): void {
    room.members.delete(member.id);
    room.rosterRevision++;
    if (this.devices.get(member.principal.deviceId)?.memberId === member.id)
      this.devices.delete(member.principal.deviceId);
    const peer = member.peer;
    member.peer = null;
    peer?.close(code);
  }
  private requireNoMembership(principal: AuthPrincipal): void {
    if (this.devices.has(principal.deviceId))
      throw new GroupFailure("capacity", "Leave the current watch group before joining another");
  }
  private async snapshot(room: Room, member: Member): Promise<GroupSnapshot> {
    const state = room.playback;
    const allowed =
      state.media === null || (await this.deps.canPlay(member.principal, state.media));
    return {
      serverInstanceId: this.serverInstanceId,
      groupId: room.id,
      membershipId: member.id,
      name: room.name,
      rosterRevision: room.rosterRevision,
      members: [...room.members.values()].map((m) => ({
        membershipId: m.id,
        displayName: m.principal.user.displayName,
        connected: m.peer !== null,
        status: m.status,
      })),
      playback: allowed
        ? { type: "playback", state }
        : {
            type: "playback-access-denied",
            revision: state.revision,
            playbackId: state.playbackId,
          },
    };
  }
  private async result(
    room: Room,
    member: Member,
    command: GroupCommand,
    outcome: GroupCommandResult["outcome"],
    code: GroupErrorCode | null,
    revision: number,
  ): Promise<GroupCommandResult> {
    return {
      commandId: command.commandId,
      outcome,
      code,
      revision,
      snapshot: await this.snapshot(room, member),
    };
  }
  private async broadcast(room: Room): Promise<void> {
    await Promise.all(
      [...room.members.values()]
        .filter((m) => m.peer !== null)
        .map(async (member) => {
          try {
            await this.liveMember(room, member.principal);
            const snapshot = await this.snapshot(room, member);
            member.peer?.send({ protocolVersion: 1, type: "snapshot", snapshot });
          } catch {
            this.removeMember(room, member, "membership_expired");
          }
        }),
    );
    this.freezeEmpty(room);
  }
  private freezeEmpty(room: Room): void {
    if ([...room.members.values()].some((m) => m.peer !== null)) return;
    room.emptySince ??= this.deps.now();
    if (room.playback.mode === "playing") {
      room.playback = transition(
        room.playback,
        { type: "set-paused", paused: true },
        this.deps.now(),
      );
      this.scheduleEnd(room);
    }
  }
  private scheduleEnd(room: Room): void {
    room.endTimer?.();
    room.endTimer = null;
    const state = room.playback;
    if (state.mode !== "playing" || state.media?.durationMs == null) return;
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, state.media.durationMs - positionAt(state, this.deps.now())),
    );
    room.endTimer = (this.deps.scheduler ?? watchGroupScheduler).after(delay, () => {
      void room.queue
        .run(async () => {
          const next = transition(
            room.playback,
            { type: "end", expectedRevision: state.revision, expectedPlaybackId: state.playbackId },
            this.deps.now(),
          );
          if (next === room.playback) {
            this.scheduleEnd(room);
            return;
          }
          room.playback = next;
          await this.broadcast(room);
        })
        .catch(() => undefined);
    });
  }
  private limitJoin(principal: AuthPrincipal): void {
    for (const key of [principal.user.id, principal.deviceId]) {
      let entry = this.attempts.get(key);
      if (entry === undefined) {
        if (this.attempts.size >= this.deps.limits.rateKeys)
          throw new GroupFailure("capacity", "Too many join attempts; retry later");
        entry = {
          bucket: new TokenBucket(
            this.deps.limits.joinAttemptsPerMinute / 60,
            this.deps.limits.joinAttemptsPerMinute,
            this.deps.now(),
          ),
          at: this.deps.now(),
        };
        this.attempts.set(key, entry);
      }
      entry.at = this.deps.now();
      if (!entry.bucket.take(entry.at))
        throw new GroupFailure("rate_limited", "Too many join attempts; retry in a minute");
    }
  }
  private async passwordWork<A>(action: () => Promise<A>, needed: boolean): Promise<A> {
    if (!needed) return action();
    if (this.hashes >= this.deps.limits.passwordOperations)
      throw new GroupFailure("capacity", "Password verification is busy; retry shortly");
    this.hashes++;
    try {
      return await action();
    } finally {
      this.hashes--;
    }
  }
  private trim<T>(map: Map<string, T>, capacity: number): void {
    while (map.size > capacity) map.delete(map.keys().next().value as string);
  }
  private errorCode(error: unknown): GroupErrorCode {
    if (error instanceof GroupFailure) return error.groupCode;
    if (error instanceof ServerError)
      return error.status === 403
        ? "denied"
        : error.status === 404
          ? "unavailable_media"
          : "unavailable";
    return "invalid_command";
  }
}
