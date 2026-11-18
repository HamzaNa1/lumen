import {
  type AdaptiveRendition,
  DEFAULT_QUALITY,
  defaultTrackMemory,
  describeTrack,
  type PlayableStream,
  type RememberedKind,
  resolveTrackSelection,
  type TrackChoiceInput,
  type TrackKind,
  type TrackMemory,
  type TrackPreferences,
} from "@lumen/contracts";
import { resolveQualityChoice } from "./adaptive/AdaptiveQuality.ts";

export interface TrackSelectionOptions {
  readonly sourceId: string;
  readonly memory?: TrackMemory;
  readonly streams: ReadonlyArray<PlayableStream>;
  readonly assertActive: () => void;
  readonly apply: (kind: TrackKind, streamId: string | null) => Promise<void>;
  /** Null means persistence is unsupported; the local selection remains in effect. */
  readonly save: (input: TrackChoiceInput) => Promise<TrackMemory | null>;
  readonly onError: (message: string | null) => void;
  /** The server answered a save with the viewer's settings, which may have changed elsewhere. */
  readonly onPreferences: (preferences: TrackPreferences) => void;
}

/** One queue per playback session keeps physical selection and persistence in user-action order. */
export class TrackSelectionController {
  private tail: Promise<void> = Promise.resolve();
  private memory: TrackMemory;
  private readonly pending = new Map<RememberedKind, TrackChoiceInput>();
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

  /**
   * Keeps the quality the player switched to for the title. What the viewer's setting plays for
   * this file inherits, so the title follows the setting again.
   */
  rememberQuality(
    choice: string,
    renditions: ReadonlyArray<AdaptiveRendition>,
    originalUsable: boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      const setting = this.memory.preferences.quality ?? DEFAULT_QUALITY;
      const remembered =
        choice === resolveQualityChoice(setting, renditions, originalUsable) ? null : choice;
      this.memory = { ...this.memory, quality: remembered };
      await this.persist({ kind: "quality", choice: remembered });
    });
  }

  retry(): Promise<void> {
    return this.enqueue(async () => {
      for (const input of [...this.pending.values()]) await this.persist(input);
    });
  }

  /** Gives up saving the choices that failed to save; they still apply to this playback. */
  dismissError(): Promise<void> {
    return this.enqueue(async () => {
      this.pending.clear();
      this.options.onError(null);
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
    let memory: TrackMemory | null;
    try {
      memory = await this.options.save(input);
    } catch {
      this.options.assertActive();
      this.options.onError("Could not save playback settings. Retry to remember your choice.");
      return;
    }
    this.options.assertActive();
    if (memory !== null) {
      this.memory = memory;
      this.options.onPreferences(memory.preferences);
    }
    this.pending.delete(input.kind);
    if (input.choice === null && memory !== null && input.kind !== "quality") {
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
        : "Could not save playback settings. Retry to remember your choice.",
    );
  }
}
