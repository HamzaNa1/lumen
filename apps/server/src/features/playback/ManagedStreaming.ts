import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { ManagedDelivery } from "@lumen/contracts";
import type { ServerConfig } from "../../config/Config";
import { canonicalPath, isPathWithin } from "../../core/Paths";
import { notFound } from "../../core/Errors";
import type { Logger } from "../../core/Logger";
import { probeFile } from "../../media/Ffprobe";
import { MediaProcessError, runMediaProcess } from "../../media/MediaProcess";
import { PackageIndex, packageFiles, validateManagedPackage } from "./ManagedPackage";
import {
  ManagedPreparationError,
  assertManagedProfile,
  managedBufferPolicy,
  managedMimeType,
  MANAGED_PROFILE,
  MAX_SEGMENT_BYTES,
  type ManagedSource,
} from "./ManagedProfile";

const LEASE_MS = 90_000;
const JOB_DEADLINE_MS = 15 * 60_000;
const MAX_QUEUE = 8;
const MAX_INDEX_ENTRIES = 256;
const PACKAGE_OVERHEAD_BYTES = 2 * MAX_SEGMENT_BYTES;

interface Job {
  readonly id: string;
  readonly source: ManagedSource;
  readonly fingerprint: string;
  readonly sourceBytes: number;
  readonly leases: Map<string, number>;
  readonly abort: AbortController;
  state: ManagedDelivery["state"];
  progress: number;
  reason: string | null;
  index: PackageIndex | null;
  bodies: number;
  completion: Promise<void> | null;
  persistedUseAtMs: number;
}

export const sourceFingerprint = async (source: ManagedSource) => {
  const details = await lstat(source.absolutePath);
  if (!details.isFile() || details.isSymbolicLink()) throw notFound("Media source is unavailable");
  const fingerprint = JSON.stringify([
    source.sourceId,
    source.absolutePath,
    details.size,
    details.mtimeMs,
    details.ctimeMs,
    details.dev,
    details.ino,
    source.video.id,
    source.video.ordinal,
    source.audio?.id ?? null,
    source.audio?.ordinal ?? null,
    MANAGED_PROFILE,
  ]);
  return {
    fingerprint,
    size: details.size,
    id: createHash("sha256").update(fingerprint).digest("hex"),
  };
};

export const pendingManagedDelivery = (reason: string | null = null): ManagedDelivery => ({
  packageId: null,
  state: reason === null ? "queued" : "failed",
  progress: 0,
  manifestUrl: null,
  mimeType: null,
  videoStreamId: null,
  audioStreamId: null,
  unavailableReason: reason,
  forwardBufferSeconds: 30,
  backBufferSeconds: 15,
  encodedWindowBytes: 0,
});

/** Owns disposable, immutable packages; playback authorization remains in PlaybackService. */
export class ManagedStreaming {
  readonly cachePath: string;
  available = false;
  private lock: Database | null = null;
  private readonly jobs = new Map<string, Job>();
  private readonly evictions = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, string>();
  private readonly queue: Job[] = [];
  private worker: Promise<void> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private admission: Promise<unknown> = Promise.resolve();
  private closed = false;
  private reservedBytes = 0;
  private cacheHits = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private cpuTimeMs = 0;
  private ioReadOperations = 0;
  private ioWriteOperations = 0;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;

  private constructor(
    private readonly config: ServerConfig,
    private readonly logger: Logger,
  ) {
    this.cachePath = join(config.dataDir, "stream-cache");
    this.ffmpeg = config.ffmpegPath;
    this.ffprobe = config.ffprobePath;
  }

  static async create(config: ServerConfig, logger: Logger): Promise<ManagedStreaming> {
    const service = new ManagedStreaming(config, logger.child({ component: "managed_streaming" }));
    if (!config.managedStreaming) return service;
    try {
      await service.initialize();
      service.available = true;
      service.sweepTimer = setInterval(() => service.expireLeases(), 5_000);
    } catch {
      service.lock?.close();
      service.lock = null;
      service.logger.warn("managed_streaming_unavailable");
    }
    return service;
  }

  private async initialize(): Promise<void> {
    await Promise.all(
      [this.ffmpeg, this.ffprobe].map((executable) =>
        runMediaProcess([executable, "-version"], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }),
      ),
    );
    await mkdir(this.cachePath, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.cachePath);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new ManagedPreparationError("Invalid managed cache directory");
    await chmod(this.cachePath, 0o700);
    // SQLite's OS-backed exclusive lock is released on crashes. No stale PID lock is stolen.
    this.lock = new Database(join(this.cachePath, "ownership.sqlite"));
    this.lock.exec(
      "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS cache_use (package_id TEXT PRIMARY KEY, last_used_at_ms INTEGER NOT NULL); COMMIT;",
    );
    const entries = await readdir(this.cachePath);
    for (const entry of entries) {
      if (entry.startsWith("temporary-")) {
        await rm(join(this.cachePath, entry), { recursive: true, force: true });
      } else if (/^[a-f0-9]{64}$/u.test(entry)) {
        try {
          const directory = join(this.cachePath, entry);
          const directoryStat = await lstat(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new ManagedPreparationError("Invalid package directory");
          const indexFile = await lstat(join(directory, "package.json"));
          if (!indexFile.isFile() || indexFile.size > 4 * 1024 ** 2)
            throw new ManagedPreparationError("Invalid cache index");
          const index = Schema.decodeUnknownSync(PackageIndex)(
            JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
          );
          if (
            index.packageId !== entry ||
            createHash("sha256").update(index.fingerprint).digest("hex") !== entry ||
            !index.fingerprint.includes(MANAGED_PROFILE) ||
            this.jobs.size >= MAX_INDEX_ENTRIES
          )
            throw new ManagedPreparationError("Invalid cache identity");
          const segments = await packageFiles(directory, this.config.streamPackageBytes);
          if (JSON.stringify(segments) !== JSON.stringify(index.segments))
            throw new ManagedPreparationError("Invalid cache files");
          const policy = managedBufferPolicy(segments);
          if (
            index.size < segments.reduce((sum, segment) => sum + segment.size, 0) ||
            index.size > this.config.streamPackageBytes ||
            !Number.isFinite(index.size) ||
            index.mimeType !==
              managedMimeType(
                await readFile(join(directory, "init.mp4")),
                index.audioStreamId !== null,
              ) ||
            policy.forwardBufferSeconds !== index.forwardBufferSeconds ||
            policy.backBufferSeconds !== index.backBufferSeconds ||
            policy.encodedWindowBytes !== index.encodedWindowBytes
          )
            throw new ManagedPreparationError("Invalid cache resource policy");
          const lastUse = this.lock
            .query<{ last_used_at_ms: number }, [string]>(
              "SELECT last_used_at_ms FROM cache_use WHERE package_id = ?",
            )
            .get(entry);
          this.jobs.set(entry, {
            id: entry,
            fingerprint: index.fingerprint,
            sourceBytes: 0,
            // Actual source bindings are supplied by an authorized prepare request before reuse.
            source: {
              sessionId: "",
              trackId: "",
              sourceId: index.sourceId,
              absolutePath: "",
              rootPath: "",
              video: { id: index.videoStreamId, ordinal: -1 },
              audio: null,
            },
            leases: new Map(),
            abort: new AbortController(),
            state: "ready",
            progress: 1,
            reason: null,
            index: { ...index, lastUsedAtMs: lastUse?.last_used_at_ms ?? index.lastUsedAtMs },
            bodies: 0,
            completion: null,
            persistedUseAtMs: lastUse?.last_used_at_ms ?? 0,
          });
        } catch {
          await rm(join(this.cachePath, entry), { recursive: true, force: true });
        }
      }
    }
    const ids = [...this.jobs.keys()];
    this.lock.run(
      `DELETE FROM cache_use${ids.length === 0 ? "" : ` WHERE package_id NOT IN (${ids.map(() => "?").join(",")})`}`,
      ids,
    );
    await this.makeRoom(0);
  }

  prepare(source: ManagedSource): Promise<ManagedDelivery> {
    const operation = this.admission.then(() => this.admit(source));
    this.admission = operation.catch(() => undefined);
    return operation;
  }

  private async admit(source: ManagedSource): Promise<ManagedDelivery> {
    if (!this.available || this.closed)
      return pendingManagedDelivery("Managed streaming is unavailable on this server");
    if (isPathWithin(await canonicalPath(source.rootPath), await canonicalPath(this.cachePath)))
      return pendingManagedDelivery("The managed cache must be outside library media roots");
    const identity = await sourceFingerprint(source);
    await this.evictions.get(identity.id);
    if (this.sessions.get(source.sessionId) !== identity.id) this.release(source.sessionId);
    let job = this.jobs.get(identity.id);
    if (
      job !== undefined &&
      job.leases.size === 0 &&
      (job.state === "cancelled" || job.state === "failed")
    ) {
      await job.completion;
      await this.evict(job);
      job = undefined;
    }
    if (job === undefined) {
      if (this.queue.length >= MAX_QUEUE)
        return pendingManagedDelivery("The managed preparation queue is full");
      this.expireLeases();
      for (const [id, existing] of this.jobs) {
        if (existing.index === null && existing.leases.size === 0 && existing.state !== "preparing")
          this.jobs.delete(id);
      }
      if (this.jobs.size >= MAX_INDEX_ENTRIES) {
        const oldest = [...this.jobs.values()]
          .filter((entry) => entry.index !== null && entry.leases.size === 0 && entry.bodies === 0)
          .sort((a, b) => (a.index?.lastUsedAtMs ?? 0) - (b.index?.lastUsedAtMs ?? 0))[0];
        if (oldest !== undefined) {
          await this.evict(oldest);
        }
      }
      if (this.jobs.size >= MAX_INDEX_ENTRIES)
        return pendingManagedDelivery("The managed cache is busy");
      if (identity.size + PACKAGE_OVERHEAD_BYTES > this.config.streamPackageBytes)
        return pendingManagedDelivery("The source exceeds the managed package size limit");
      job = {
        id: identity.id,
        source,
        fingerprint: identity.fingerprint,
        sourceBytes: identity.size,
        leases: new Map(),
        abort: new AbortController(),
        state: "queued",
        progress: 0,
        reason: null,
        index: null,
        bodies: 0,
        completion: null,
        persistedUseAtMs: 0,
      };
      this.jobs.set(job.id, job);
      this.queue.push(job);
    } else if (job.state === "ready") {
      this.cacheHits += 1;
      job.leases.set(source.sessionId, Date.now() + LEASE_MS);
      this.sessions.set(source.sessionId, job.id);
      try {
        await packageFiles(join(this.cachePath, job.id), this.config.streamPackageBytes);
      } catch {
        this.invalidate(job, "The prepared package is unavailable");
      }
    }
    if (this.closed)
      return pendingManagedDelivery("Managed streaming is unavailable on this server");
    job.leases.set(source.sessionId, Date.now() + LEASE_MS);
    this.sessions.set(source.sessionId, job.id);
    this.kick();
    return this.describe(job, source.trackId);
  }

  async status(source: ManagedSource): Promise<ManagedDelivery> {
    const job = this.sessionJob(source.sessionId);
    if (job === undefined)
      return {
        ...pendingManagedDelivery("Preparation was cancelled or its lease expired"),
        state: "cancelled",
      };
    try {
      if ((await sourceFingerprint(source)).id !== job.id)
        this.invalidate(job, "The source changed during preparation");
    } catch {
      this.invalidate(job, "The source is unavailable");
    }
    this.touch(source.sessionId);
    return this.describe(job, source.trackId);
  }

  touch(sessionId: string): void {
    const job = this.sessionJob(sessionId);
    if (job !== undefined) job.leases.set(sessionId, Date.now() + LEASE_MS);
  }

  release(sessionId: string): void {
    const id = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const job = id === undefined ? undefined : this.jobs.get(id);
    job?.leases.delete(sessionId);
    // Defer cancellation until the current admission turn can attach a replacement waiter.
    queueMicrotask(() => this.expireLeases());
  }

  private sessionJob(sessionId: string): Job | undefined {
    const id = this.sessions.get(sessionId);
    const job = id === undefined ? undefined : this.jobs.get(id);
    return (job?.leases.get(sessionId) ?? 0) > Date.now() ? job : undefined;
  }

  private expireLeases(): void {
    for (const job of this.jobs.values()) {
      for (const [session, until] of job.leases) {
        if (until <= Date.now()) {
          job.leases.delete(session);
          if (this.sessions.get(session) === job.id) this.sessions.delete(session);
        }
      }
      if (job.leases.size === 0 && (job.state === "queued" || job.state === "preparing")) {
        job.state = "cancelled";
        job.reason = "Preparation was cancelled";
        job.abort.abort();
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
      }
    }
  }

  private describe(job: Job, trackId: string): ManagedDelivery {
    return {
      ...pendingManagedDelivery(),
      packageId: job.id,
      state: job.state,
      progress: job.progress,
      unavailableReason: job.reason,
      manifestUrl:
        job.state === "ready"
          ? `/api/v1/managed-media/${encodeURIComponent(trackId)}/${job.id}/index.m3u8`
          : null,
      mimeType: job.index?.mimeType ?? null,
      videoStreamId: job.index?.videoStreamId ?? job.source.video.id,
      audioStreamId: job.index?.audioStreamId ?? job.source.audio?.id ?? null,
      forwardBufferSeconds: job.index?.forwardBufferSeconds ?? 30,
      backBufferSeconds: job.index?.backBufferSeconds ?? 15,
      encodedWindowBytes: job.index?.encodedWindowBytes ?? 0,
    };
  }

  private kick(): void {
    if (this.worker !== null || this.closed || !this.available) return;
    this.worker = this.drain().finally(() => {
      this.worker = null;
      if (this.queue.length > 0 && !this.closed && this.available) this.kick();
    });
    void this.worker.catch(() => this.logger.error("managed_worker_failed"));
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.available) {
      const job = this.queue.shift();
      if (job === undefined) return;
      if (job.state !== "queued" || job.leases.size === 0) continue;
      job.completion = this.package(job);
      await job.completion;
      job.completion = null;
    }
  }

  private usedBytes(): number {
    return [...this.jobs.values()].reduce((sum, job) => sum + (job.index?.size ?? 0), 0);
  }

  private evict(job: Job): Promise<void> {
    const existing = this.evictions.get(job.id);
    if (existing !== undefined) return existing;
    const operation = rm(join(this.cachePath, job.id), { recursive: true, force: true })
      .then(() => {
        if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
        this.lock?.run("DELETE FROM cache_use WHERE package_id = ?", [job.id]);
      })
      .finally(() => this.evictions.delete(job.id));
    this.evictions.set(job.id, operation);
    return operation;
  }

  private async makeRoom(bytes: number): Promise<void> {
    const candidates = [...this.jobs.values()]
      .filter((job) => job.index !== null && job.leases.size === 0 && job.bodies === 0)
      .sort((a, b) => (a.index?.lastUsedAtMs ?? 0) - (b.index?.lastUsedAtMs ?? 0));
    while (
      this.usedBytes() + this.reservedBytes + bytes > this.config.streamCacheBytes &&
      candidates.length > 0
    ) {
      const job = candidates.shift();
      if (job === undefined || job.leases.size !== 0 || job.bodies !== 0) continue;
      await this.evict(job);
    }
    if (this.usedBytes() + this.reservedBytes + bytes > this.config.streamCacheBytes)
      throw new ManagedPreparationError("The managed cache budget is in use");
  }

  private async package(job: Job): Promise<void> {
    const startedAt = performance.now();
    const temporary = join(this.cachePath, `temporary-${job.id}`);
    let monitor: ReturnType<typeof setInterval> | undefined;
    let monitoring: Promise<void> | null = null;
    const reservation = Math.ceil(job.sourceBytes * 1.1) + PACKAGE_OVERHEAD_BYTES;
    let reserved = false;
    const deadline = setTimeout(
      () => job.abort.abort(new ManagedPreparationError("Managed preparation timed out")),
      JOB_DEADLINE_MS,
    );
    try {
      job.state = "preparing";
      const probe = await probeFile(
        this.ffprobe,
        job.source.absolutePath,
        this.config.ffprobeTimeoutMs,
        this.config.ffprobeMaxOutputBytes,
        job.abort.signal,
      );
      assertManagedProfile(job.source, probe);
      if ((await sourceFingerprint(job.source)).id !== job.id)
        throw new ManagedPreparationError("The source changed before preparation");
      if (reservation > this.config.streamPackageBytes)
        throw new ManagedPreparationError("The source exceeds the managed package size limit");
      await this.makeRoom(reservation);
      const disk = await statfs(this.cachePath);
      if (disk.bavail * disk.bsize < reservation + this.config.streamFreeReserveBytes)
        throw new ManagedPreparationError(
          "There is insufficient free space for managed preparation",
        );
      this.reservedBytes = reservation;
      reserved = true;
      await mkdir(temporary, { mode: 0o700 });
      const checkOutput = async () => {
        let bytes = 0;
        const entries = await readdir(temporary);
        if (entries.length > 21_604)
          throw new ManagedPreparationError("The package has too many segments");
        for (const name of entries) bytes += (await lstat(join(temporary, name))).size;
        const free = await statfs(this.cachePath);
        if (bytes > reservation || free.bavail * free.bsize < this.config.streamFreeReserveBytes)
          throw new ManagedPreparationError("Managed preparation exceeded its disk reservation");
      };
      monitor = setInterval(() => {
        if (monitoring !== null) return;
        monitoring = checkOutput()
          .catch((cause: unknown) => job.abort.abort(cause))
          .finally(() => {
            monitoring = null;
          });
      }, 500);
      let progressBuffer = "";
      await runMediaProcess(
        [
          this.ffmpeg,
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          job.source.absolutePath,
          "-map",
          `0:${job.source.video.ordinal}`,
          ...(job.source.audio === null ? ["-an"] : ["-map", `0:${job.source.audio.ordinal}`]),
          "-c",
          "copy",
          "-sn",
          "-dn",
          "-avoid_negative_ts",
          "make_zero",
          "-f",
          "hls",
          "-hls_time",
          "4",
          "-hls_playlist_type",
          "vod",
          "-hls_segment_type",
          "fmp4",
          "-hls_fmp4_init_filename",
          "init.mp4",
          "-hls_segment_filename",
          join(temporary, "segment-%d.m4s"),
          "-progress",
          "pipe:1",
          "-nostats",
          join(temporary, "index.m3u8"),
        ],
        {
          timeoutMs: JOB_DEADLINE_MS,
          idleTimeoutMs: 60_000,
          maxOutputBytes: 64 * 1024,
          signal: job.abort.signal,
          onExit: (usage) => {
            this.cpuTimeMs += Number(usage?.cpuTime.total ?? 0) / 1000;
            this.ioReadOperations += Number(usage?.ops.in ?? 0);
            this.ioWriteOperations += Number(usage?.ops.out ?? 0);
          },
          onStdout: (chunk) => {
            progressBuffer += chunk;
            for (const line of progressBuffer.split("\n").slice(0, -1)) {
              const match = /^out_time_us=(\d+)$/u.exec(line);
              if (match !== null && probe.durationMs !== null)
                job.progress = Math.max(
                  job.progress,
                  Math.min(0.95, Number(match[1]) / (probe.durationMs * 1000)),
                );
            }
            progressBuffer = progressBuffer
              .slice(progressBuffer.lastIndexOf("\n") + 1)
              .slice(-1024);
          },
        },
      );
      await checkOutput();
      const validated = await validateManagedPackage(
        temporary,
        this.ffprobe,
        this.config.streamPackageBytes,
        (probe.durationMs ?? 0) / 1000,
        job.source.audio !== null,
        job.abort.signal,
      );
      if ((await sourceFingerprint(job.source)).id !== job.id)
        throw new ManagedPreparationError("The source changed during preparation");
      job.abort.signal.throwIfAborted();
      const size =
        (
          await Promise.all((await readdir(temporary)).map((name) => lstat(join(temporary, name))))
        ).reduce((sum, details) => sum + details.size, 0) +
        4 * 1024 ** 2;
      if (size > reservation)
        throw new ManagedPreparationError("The package index exceeds its disk reservation");
      const index: PackageIndex = {
        ...validated,
        packageId: job.id,
        fingerprint: job.fingerprint,
        sourceId: job.source.sourceId,
        videoStreamId: job.source.video.id,
        audioStreamId: job.source.audio?.id ?? null,
        size,
        lastUsedAtMs: Date.now(),
      };
      await Bun.write(join(temporary, "package.json"), JSON.stringify(index));
      job.abort.signal.throwIfAborted();
      await rename(temporary, join(this.cachePath, job.id));
      job.index = index;
      job.state = "ready";
      job.progress = 1;
      this.completedJobs += 1;
      this.persistUse(job);
      this.logger.info("managed_package_ready", {
        packageId: job.id,
        bytes: size,
        segments: index.segments.length,
        durationMs: Math.round(performance.now() - startedAt),
        sourceBytes: job.sourceBytes,
      });
    } catch (cause) {
      const reason = job.abort.signal.reason;
      this.failedJobs += 1;
      job.state =
        job.abort.signal.aborted && !(reason instanceof Error && reason.name !== "AbortError")
          ? "cancelled"
          : "failed";
      const failure = job.abort.signal.aborted ? reason : cause;
      job.reason =
        failure instanceof ManagedPreparationError || failure instanceof MediaProcessError
          ? failure.message
          : job.state === "cancelled"
            ? "Preparation was cancelled"
            : "Managed preparation could not verify its source or cache";
      this.logger.warn("managed_package_failed", { packageId: job.id, state: job.state });
    } finally {
      clearTimeout(deadline);
      clearInterval(monitor);
      await monitoring;
      try {
        await rm(temporary, { recursive: true, force: true });
        if (reserved) this.reservedBytes = 0;
      } catch {
        this.available = false;
        this.logger.error("managed_cache_cleanup_failed");
      }
    }
  }

  private invalidate(job: Job, reason: string): void {
    job.state = "failed";
    job.reason = reason;
    job.abort.abort(new ManagedPreparationError(reason));
  }

  async artifact(source: ManagedSource, packageId: string, name: string) {
    const job = this.sessionJob(source.sessionId);
    if (
      job === undefined ||
      job.id !== packageId ||
      job.state !== "ready" ||
      job.index === null ||
      job.index.sourceId !== source.sourceId ||
      (await sourceFingerprint(source)).id !== packageId
    )
      throw notFound("Managed package is unavailable for this session");
    if (
      name !== "index.m3u8" &&
      name !== "init.mp4" &&
      !job.index.segments.some((segment) => segment.name === name)
    )
      throw notFound("Managed artifact not found");
    job.bodies += 1;
    try {
      const path = join(this.cachePath, packageId, name);
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink())
        throw new ManagedPreparationError("Invalid package file");
      this.touch(source.sessionId);
      job.index = { ...job.index, lastUsedAtMs: Date.now() };
      this.persistUse(job);
      return {
        path,
        size: file.size,
        modifiedAtMs: file.mtimeMs,
        mimeType: name === "index.m3u8" ? "application/vnd.apple.mpegurl" : "video/mp4",
        release: () => {
          job.bodies -= 1;
        },
      };
    } catch {
      job.bodies -= 1;
      this.invalidate(job, "A prepared package file is missing");
      throw notFound("Managed package is unavailable");
    }
  }

  private persistUse(job: Job): void {
    const use = job.index?.lastUsedAtMs;
    if (use === undefined || use - job.persistedUseAtMs < 30_000 || this.lock === null) return;
    try {
      this.lock.run(
        "INSERT INTO cache_use(package_id, last_used_at_ms) VALUES (?, ?) ON CONFLICT(package_id) DO UPDATE SET last_used_at_ms=excluded.last_used_at_ms",
        [job.id, use],
      );
      job.persistedUseAtMs = use;
    } catch {
      this.logger.warn("managed_cache_use_not_saved");
    }
  }

  metrics(): string {
    const values = {
      available: this.available ? 1 : 0,
      queued: this.queue.length,
      preparing: [...this.jobs.values()].filter((job) => job.state === "preparing").length,
      cache_bytes: this.usedBytes(),
      reserved_bytes: this.reservedBytes,
      open_bodies: [...this.jobs.values()].reduce((sum, job) => sum + job.bodies, 0),
      cache_hits_total: this.cacheHits,
      completed_jobs_total: this.completedJobs,
      failed_jobs_total: this.failedJobs,
      packaging_cpu_ms_total: this.cpuTimeMs,
      packaging_read_operations_total: this.ioReadOperations,
      packaging_write_operations_total: this.ioWriteOperations,
    };
    return Object.entries(values)
      .map(([name, value]) => `lumen_managed_${name} ${value}\n`)
      .join("");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.available = false;
    clearInterval(this.sweepTimer);
    for (const job of this.jobs.values()) job.abort.abort();
    await this.admission.catch(() => undefined);
    await this.worker?.catch(() => undefined);
    this.lock?.close();
    this.lock = null;
  }
}
