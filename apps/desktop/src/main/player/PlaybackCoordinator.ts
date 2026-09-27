import type {
  CreateWatchGroup,
  GroupAction,
  GroupSnapshot,
  IpcWatchGroupState,
} from "@lumen/contracts";
import type { ServerClient } from "../api/ServerClient";
import type { PlayerController } from "./PlayerController";
import { WatchGroupConnection } from "../watch-groups/WatchGroupConnection";
import { WatchGroupController } from "../watch-groups/WatchGroupController";

type Player = Pick<
  PlayerController,
  "start" | "pause" | "seek" | "stop" | "getState" | "sample" | "setPlaybackRate" | "waitForSurface"
>;
interface GroupContext {
  readonly client: ServerClient;
  readonly connectionId: string;
  readonly membership: GroupSnapshot;
  readonly connection: WatchGroupConnection;
  readonly controller: WatchGroupController;
}
interface Intent {
  action: GroupAction;
  readonly context: GroupContext;
  readonly resolve: (() => void)[];
  readonly reject: ((error: unknown) => void)[];
}
export class PlaybackCoordinator {
  private group: GroupContext | null = null;
  private state: IpcWatchGroupState | null = null;
  private joining = false;
  private generation = 0;
  private readonly intents: Intent[] = [];
  private sending = false;
  constructor(
    private readonly player: Player,
    private readonly onState: (state: IpcWatchGroupState | null) => void,
  ) {}
  getState(): IpcWatchGroupState | null {
    return this.state;
  }
  async create(
    client: ServerClient,
    connectionId: string,
    input: CreateWatchGroup,
  ): Promise<IpcWatchGroupState | null> {
    return this.enter(client, connectionId, () => client.createWatchGroup(input));
  }
  async join(
    client: ServerClient,
    connectionId: string,
    groupId: string,
    password?: string,
  ): Promise<IpcWatchGroupState | null> {
    return this.enter(client, connectionId, () => client.joinWatchGroup(groupId, password));
  }
  async leave(): Promise<void> {
    this.generation++;
    const group = this.group;
    this.group = null;
    this.state = null;
    this.onState(null);
    for (const intent of this.intents.splice(0))
      for (const reject of intent.reject) reject(new Error("Left the watch group"));
    if (group !== null) {
      group.connection.dispose();
      await group.controller.dispose();
      await group.client.leaveWatchGroup(group.membership.groupId).catch(() => undefined);
    } else await this.player.stop();
  }
  async start(
    input: Parameters<Player["start"]>[0],
  ): Promise<Awaited<ReturnType<Player["start"]>> | null> {
    if (this.group === null) return this.player.start(input);
    if (this.group.connectionId !== input.connectionId)
      throw new Error("Leave the active watch group before switching servers");
    await this.intent({
      type: "start",
      itemId: input.itemId,
      positionMs: (input.startAtSeconds ?? 0) * 1_000,
    });
    return null;
  }
  async pause(sessionId: string, paused: boolean) {
    if (this.group === null) return this.player.pause(sessionId, paused);
    await this.intent({ type: "set-paused", paused });
    return this.player.getState();
  }
  async seek(sessionId: string, positionSeconds: number) {
    if (this.group === null) return this.player.seek(sessionId, positionSeconds);
    await this.intent({ type: "seek", positionMs: positionSeconds * 1_000 });
    return this.player.getState();
  }
  async stop(): Promise<void> {
    if (this.group === null) await this.player.stop();
    else await this.intent({ type: "stop" });
  }
  async cleanup(): Promise<void> {
    await this.leave();
  }
  async tick(): Promise<void> {
    await this.group?.controller.tick();
  }
  resume(): void {
    this.group?.connection.resume();
  }
  retry(): void {
    this.group?.controller.retry();
    this.group?.connection.requestSnapshot();
  }
  localFailure(error: unknown): void {
    if ((error as { status?: number } | null)?.status === 409)
      this.group?.controller.renewSession();
    else this.group?.connection.requestSnapshot();
  }
  private async enter(
    client: ServerClient,
    connectionId: string,
    accept: () => Promise<GroupSnapshot>,
  ): Promise<IpcWatchGroupState | null> {
    if (this.group !== null || this.joining)
      throw new Error("Leave the current watch group before joining another");
    this.joining = true;
    const generation = ++this.generation;
    let membership: GroupSnapshot | null = null;
    try {
      membership = await accept();
      if (generation !== this.generation) {
        await client.leaveWatchGroup(membership.groupId);
        return null;
      }
      await this.player.stop();
      if (generation !== this.generation) {
        await client.leaveWatchGroup(membership.groupId);
        return null;
      }
      const groupId = membership.groupId;
      let connection: WatchGroupConnection;
      let reportedStatus: string | null = null;
      const controller = new WatchGroupController({
        player: {
          loadPaused: async (session, signal) => {
            await this.player.waitForSurface(signal);
            await this.player.start({
              client,
              connectionId,
              itemId: session.itemId,
              session,
              paused: true,
              signal,
            });
          },
          seekExact: async (seconds, signal) => {
            const state = this.player.getState();
            if (state === null) throw new Error("Player unavailable");
            await this.player.seek(state.sessionId, seconds, signal);
          },
          setPaused: async (paused) => {
            const state = this.player.getState();
            if (state !== null) await this.player.pause(state.sessionId, paused);
          },
          setPlaybackRate: (rate) => this.player.setPlaybackRate(rate),
          sample: () => this.player.sample(),
          stopLocal: () => this.player.stop(),
        },
        acquire: (playbackId, signal) => client.watchGroupSession(groupId, playbackId, signal),
        release: (session) => client.closePlayback(session.sessionId),
        now: () => performance.now(),
        clock: (now) => connection.clock.estimate(now),
        onStatus: (status, error) => {
          if (generation !== this.generation || this.state === null || !connection.ready) return;
          const memberStatus =
            status === "blocked"
              ? "blocked"
              : status === "failed"
                ? "failed"
                : status === "ready"
                  ? "ready"
                  : "buffering";
          if (memberStatus !== reportedStatus) {
            reportedStatus = memberStatus;
            connection.memberStatus(memberStatus);
          }
          this.publish({ ...this.state, status, error });
        },
      });
      connection = new WatchGroupConnection({
        api: client,
        membership,
        onSnapshot: (snapshot) => {
          if (generation !== this.generation || this.state === null) return;
          this.publish({ ...this.state, snapshot });
          controller.update(snapshot);
        },
        onStatus: (status, error) => {
          if (generation !== this.generation || this.state === null) return;
          this.publish({ ...this.state, status, error });
          controller.setConnected(status === "ready");
          if (status === "ended") void controller.dispose();
        },
      });
      this.group = { client, connectionId, membership, connection, controller };
      this.publish({ connectionId, status: "connecting", snapshot: null, error: null });
      connection.start();
      return this.state;
    } catch (error) {
      if (membership !== null)
        await client.leaveWatchGroup(membership.groupId).catch(() => undefined);
      throw error;
    } finally {
      this.joining = false;
    }
  }
  private publish(state: IpcWatchGroupState): void {
    if (JSON.stringify(this.state) === JSON.stringify(state)) return;
    this.state = state;
    this.onState(state);
  }
  private intent(action: GroupAction): Promise<void> {
    const context = this.group;
    if (context === null || !context.connection.ready)
      return Promise.reject(new Error("Group controls are unavailable while reconnecting"));
    if (this.intents.length >= 20)
      return Promise.reject(new Error("Too many pending playback controls"));
    return new Promise((resolve, reject) => {
      const last = this.intents.at(-1);
      if (action.type === "seek" && last?.action.type === "seek" && last.context === context) {
        last.action = action;
        last.resolve.push(resolve);
        last.reject.push(reject);
      } else this.intents.push({ action, context, resolve: [resolve], reject: [reject] });
      void this.drain();
    });
  }
  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let next = this.intents.shift(); next !== undefined; next = this.intents.shift()) {
        try {
          if (next.context !== this.group) throw new Error("Watch group changed");
          const result = await next.context.connection.submit(next.action);
          if (result.outcome !== "accepted")
            throw new Error(
              result.code === "stale_state"
                ? "Playback changed before this control arrived. Try again."
                : `Playback control rejected: ${result.code}`,
            );
          for (const resolve of next.resolve) resolve();
        } catch (error) {
          for (const reject of next.reject) reject(error);
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
