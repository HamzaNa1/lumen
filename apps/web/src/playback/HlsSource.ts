import Hls, { ErrorDetails, ErrorTypes, type HlsConfig } from "hls.js";
import type { ManagedDelivery, PlayerSession } from "@lumen/contracts";
import { PlaybackUnsupportedError } from "@lumen/client";
import type { MediaElementLike } from "../HtmlMediaPlayer";
import { createManagedLoader, managedUrl } from "./ManagedLoader";
import type { DeliveryRecovery } from "./DeliveryRecovery";
import { DeliveryFailure, type MediaSourceAdapter, waitForMediaMetadata } from "./MediaSource";

export const supportsManagedType = (type: string): boolean => {
  const source = globalThis.MediaSource;
  return Hls.isSupported() && (source?.isTypeSupported(type) ?? false);
};

export const managedSeekPosition = (element: MediaElementLike, position: number): number => {
  // Stream-copy B-frame timing can leave a sub-frame gap at the start of the MSE timeline.
  if (position <= 0.25 && element.buffered.length > 0) {
    const start = element.buffered.start(0);
    if (start > position && start <= 0.25) return start;
  }
  return position;
};

export const managedHlsConfig = (
  delivery: ManagedDelivery,
  startAtSeconds: number,
): Partial<HlsConfig> => {
  const loadPolicy = {
    default: {
      maxTimeToFirstByteMs: 7_000,
      maxLoadTimeMs: 7_000,
      timeoutRetry: null,
      errorRetry: null,
    },
  };
  return {
    autoStartLoad: false,
    startPosition: startAtSeconds,
    maxBufferLength: delivery.forwardBufferSeconds,
    maxMaxBufferLength: delivery.forwardBufferSeconds,
    backBufferLength: delivery.backBufferSeconds,
    frontBufferFlushThreshold: delivery.forwardBufferSeconds,
    maxBufferSize: 64 * 1024 ** 2,
    lowLatencyMode: false,
    progressive: false,
    startFragPrefetch: false,
    testBandwidth: false,
    appendErrorMaxRetry: 0,
    appendTimeout: 10_000,
    fragLoadPolicy: loadPolicy,
    manifestLoadPolicy: loadPolicy,
    playlistLoadPolicy: loadPolicy,
    keyLoadPolicy: loadPolicy,
    certLoadPolicy: loadPolicy,
    steeringManifestLoadPolicy: loadPolicy,
    interstitialAssetListLoadPolicy: loadPolicy,
  };
};

export class HlsSource implements MediaSourceAdapter {
  readonly kind = "managed";
  private hls: Hls | null = null;
  private quotaRecoveries = 0;
  private loaded = false;
  private readonly segments = new Map<number, { start: number; end: number; bytes: number }>();
  private cancelLoad: (() => void) | null = null;

  constructor(
    private readonly element: MediaElementLike,
    private readonly origin: string,
    private readonly delivery: ManagedDelivery,
    private readonly recovery: DeliveryRecovery,
    private readonly workerPath: string,
    private readonly timeoutMs: number,
    private readonly onFailure: (failure: DeliveryFailure) => void,
  ) {}

  async load(session: PlayerSession, startAtSeconds: number, signal: AbortSignal): Promise<void> {
    const { delivery } = this;
    if (
      delivery.state !== "ready" ||
      delivery.manifestUrl === null ||
      delivery.mimeType === null ||
      !supportsManagedType(delivery.mimeType)
    )
      throw new PlaybackUnsupportedError(
        "This browser cannot decode the managed playback profile.",
      );
    const manifest = managedUrl(delivery.manifestUrl, delivery.manifestUrl, this.origin);
    const worker = new URL(this.workerPath, this.origin);
    if (
      worker.origin !== new URL(this.origin).origin ||
      !worker.pathname.startsWith("/web/assets/")
    )
      throw new Error("The managed worker must belong to this server");
    const controller = new AbortController();
    this.cancelLoad = () => controller.abort();
    const loadSignal = AbortSignal.any([signal, controller.signal]);
    let failure: DeliveryFailure | null = null;
    const hls = new Hls({
      ...managedHlsConfig(delivery, startAtSeconds),
      loader: createManagedLoader(this.origin, manifest.href, session.grantToken, this.recovery),
      enableWorker: true,
      workerPath: worker.href,
    });
    this.hls = hls;
    hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
      if (this.hls !== hls || typeof data.frag.sn !== "number") return;
      this.segments.set(data.frag.sn, {
        start: data.frag.start,
        end: data.frag.end,
        bytes: data.frag.stats.total,
      });
      this.estimatedEncodedBytes();
      if (startAtSeconds <= 0.25 && !this.element.seeking && this.element.currentTime <= 0.25)
        this.seek(this.element.currentTime);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (this.hls !== hls || signal.aborted) return;
      if (data.details === ErrorDetails.BUFFER_FULL_ERROR && this.quotaRecoveries++ === 0) {
        hls.config.maxBufferLength = hls.config.maxMaxBufferLength = Math.max(
          5,
          hls.config.maxBufferLength / 2,
        );
        hls.config.backBufferLength = 0;
        return;
      }
      if (!data.fatal && data.details !== ErrorDetails.BUFFER_FULL_ERROR) return;
      const code = data.response?.code;
      const kind =
        code === 401 || code === 403 || code === 404
          ? "authorization"
          : data.details === ErrorDetails.BUFFER_FULL_ERROR
            ? "quota"
            : data.type === ErrorTypes.NETWORK_ERROR
              ? "transport"
              : "decode";
      failure = new DeliveryFailure(
        kind,
        kind === "authorization"
          ? "Managed media access is no longer available."
          : kind === "transport"
            ? "Managed playback exhausted its connection recovery budget."
            : kind === "quota"
              ? "This browser cannot hold the managed playback buffer."
              : "This browser cannot decode this managed file.",
      );
      hls.stopLoad();
      if (this.loaded) this.onFailure(failure);
      else controller.abort();
    });
    try {
      await waitForMediaMetadata(
        this.element,
        loadSignal,
        this.timeoutMs,
        () => {
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (this.hls === hls && !loadSignal.aborted) hls.startLoad(startAtSeconds);
          });
          hls.attachMedia(this.element as HTMLMediaElement);
          hls.loadSource(manifest.href);
        },
        () => new DeliveryFailure("decode", "This browser cannot decode this managed file."),
      );
      this.loaded = true;
    } catch (cause) {
      throw failure ?? cause;
    } finally {
      this.cancelLoad = null;
    }
  }

  seek(position: number): void {
    this.element.currentTime = managedSeekPosition(this.element, position);
  }
  estimatedEncodedBytes(): number {
    let total = 0;
    for (const [id, segment] of this.segments) {
      let retained = false;
      for (let range = 0; range < this.element.buffered.length; range += 1) {
        if (
          this.element.buffered.start(range) < segment.end &&
          this.element.buffered.end(range) > segment.start
        )
          retained = true;
      }
      if (retained) total += segment.bytes;
      else this.segments.delete(id);
    }
    return total;
  }

  dispose(): void {
    this.cancelLoad?.();
    const hls = this.hls;
    this.hls = null;
    hls?.destroy();
    this.segments.clear();
  }
}
