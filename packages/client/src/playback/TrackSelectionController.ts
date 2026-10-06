import {
  defaultTrackMemory,
  describeTrack,
  resolveTrackSelection,
  type PlayableStream,
  type TrackChoiceInput,
  type TrackKind,
  type TrackMemory,
} from "@lumen/contracts";

export interface TrackSelectionOptions {
  readonly sourceId: string;
  readonly memory?: TrackMemory;
  readonly streams: ReadonlyArray<PlayableStream>;
  readonly assertActive: () => void;
  readonly apply: (kind: TrackKind, streamId: string | null) => Promise<void>;
  readonly save: (input: TrackChoiceInput) => Promise<TrackMemory>;
  readonly onError: (message: string | null) => void;
}

/** One queue per playback session keeps physical selection and persistence in user-action order. */
export class TrackSelectionController {
  private tail: Promise<void> = Promise.resolve();
  private memory: TrackMemory;
  private readonly pending = new Map<TrackKind, TrackChoiceInput>();
  constructor(private readonly options: TrackSelectionOptions) {
    this.memory = options.memory ?? defaultTrackMemory();
  }

  select(kind: TrackKind, streamId: string | null): Promise<void> {
    return this.enqueue(async () => {
      if (streamId === null && kind === "audio") throw new Error("Audio cannot be Off");
      const stream = this.options.streams.find(
        (track) => track.id === streamId && track.kind === kind,
      );
      if (streamId !== null && stream === undefined) throw new Error("Stream is unavailable");
      await this.options.apply(kind, streamId);
      this.options.assertActive();
      this.memory = {
        ...this.memory,
        [kind]: stream === undefined ? "off" : describeTrack(this.options.sourceId, stream),
      };
      await this.persist({ kind, choice: streamId ?? "off" });
    });
  }

  reset(kind: TrackKind): Promise<void> {
    return this.enqueue(async () => {
      const inherited = { ...this.memory, [kind]: null };
      const selected = resolveTrackSelection(
        this.options.streams,
        this.options.sourceId,
        inherited,
      );
      await this.options.apply(kind, selected[kind]?.id ?? null);
      this.options.assertActive();
      this.memory = inherited;
      await this.persist({ kind, choice: null });
    });
  }

  retry(): Promise<void> {
    return this.enqueue(async () => {
      for (const input of [...this.pending.values()]) await this.persist(input);
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      this.options.assertActive();
      await action();
      this.options.assertActive();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async persist(input: TrackChoiceInput): Promise<void> {
    this.pending.set(input.kind, input);
    let memory: TrackMemory;
    try {
      memory = await this.options.save(input);
    } catch {
      this.options.assertActive();
      this.options.onError(
        "Could not save audio or subtitle settings. Retry to remember your choice.",
      );
      return;
    }
    this.options.assertActive();
    this.memory = memory;
    this.pending.delete(input.kind);
    if (input.choice === null) {
      const selected = resolveTrackSelection(
        this.options.streams,
        this.options.sourceId,
        this.memory,
      );
      await this.options.apply(input.kind, selected[input.kind]?.id ?? null);
      this.options.assertActive();
    }
    this.options.onError(
      this.pending.size === 0
        ? null
        : "Could not save audio or subtitle settings. Retry to remember your choice.",
    );
  }
}
