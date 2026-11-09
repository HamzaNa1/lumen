import { sep } from "node:path";
import type { ScanRunStats } from "@lumen/contracts";

export interface ObservedFile {
  readonly rootId: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileSizeBytes: number;
  readonly modifiedAtMs: number;
  readonly inode: string;
  readonly device: string;
}

export interface RootObservation {
  readonly rootId: string;
  readonly result: "complete" | "unavailable" | "empty-unconfirmed";
  readonly files: ReadonlyMap<string, ObservedFile>;
  readonly unreadable: ReadonlyArray<string>;
}

export interface SourceSnapshot {
  readonly id: string;
  readonly rootId: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileSizeBytes: number | null;
  readonly modifiedAtMs: number | null;
  readonly inode: string | null;
  readonly device: string | null;
  readonly isAvailable: boolean | null;
}

export interface RootSnapshot {
  readonly id: string;
  readonly isAvailable: boolean;
  readonly unavailableReason: string | null;
}

export interface LibrarySnapshot {
  readonly sources: ReadonlyArray<SourceSnapshot>;
  readonly incomplete: ReadonlySet<string>;
  readonly roots: ReadonlyArray<RootSnapshot>;
}

export interface ScanMode {
  readonly mode: "incremental" | "full";
  readonly userInitiated: boolean;
}

export interface SourceUpdate {
  readonly source: SourceSnapshot;
  readonly file: ObservedFile;
  readonly changed: boolean;
}

export interface ReconcilePlan {
  readonly inserts: ReadonlyArray<ObservedFile>;
  readonly updates: ReadonlyArray<SourceUpdate>;
  readonly moves: ReadonlyArray<SourceUpdate>;
  readonly missing: ReadonlyArray<SourceSnapshot>;
  readonly probes: ReadonlyArray<ObservedFile>;
  readonly availability: ReadonlyArray<{ readonly rootId: string; readonly reason: string | null }>;
  readonly stats: ScanRunStats;
}

export const emptyStats = (): { -readonly [K in keyof ScanRunStats]: ScanRunStats[K] } => ({
  discovered: 0,
  new: 0,
  changed: 0,
  moved: 0,
  unchanged: 0,
  skipped: 0,
  missing: 0,
  probesEnqueued: 0,
});

export const hasChanges = (plan: ReconcilePlan): boolean =>
  plan.inserts.length +
    plan.updates.length +
    plan.missing.length +
    plan.probes.length +
    plan.availability.length >
  0;

const under = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}${sep}`);
const identity = (file: Pick<SourceSnapshot, "device" | "inode" | "fileSizeBytes">) =>
  file.device === null || file.inode === null || file.fileSizeBytes === null
    ? null
    : JSON.stringify([file.device, file.inode, file.fileSizeBytes]);

// Pre-migration sources have no device. Preserve legacy matching only inside their
// own readable root; the next observation records the device and ends the exception.
const legacyIdentity = (file: Pick<SourceSnapshot, "rootId" | "inode" | "fileSizeBytes">) =>
  file.inode === null || file.fileSizeBytes === null
    ? null
    : JSON.stringify(["legacy", file.rootId, file.inode, file.fileSizeBytes]);

export const diff = (
  observations: ReadonlyArray<RootObservation>,
  snapshot: LibrarySnapshot,
  mode: ScanMode,
): ReconcilePlan => {
  const rootsWithSources = new Set(snapshot.sources.map((source) => source.rootId));
  const roots = new Map(
    observations.map((root) => [
      root.rootId,
      {
        ...root,
        result:
          root.result === "empty-unconfirmed" && !rootsWithSources.has(root.rootId)
            ? "complete"
            : root.result,
      },
    ]),
  );
  const files = new Map(observations.flatMap((root) => [...root.files]));
  const byPath = new Map(snapshot.sources.map((source) => [source.absolutePath, source]));
  const canRemove = (source: SourceSnapshot) => {
    const root = roots.get(source.rootId);
    return (
      root?.result === "complete" &&
      !root.unreadable.some((prefix) => under(source.absolutePath, prefix))
    );
  };
  const candidates = new Map<string, SourceSnapshot[]>();
  for (const source of [...snapshot.sources].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const key = source.device === null ? legacyIdentity(source) : identity(source);
    if (key === null || files.has(source.absolutePath) || !canRemove(source)) continue;
    const bucket = candidates.get(key) ?? [];
    bucket.push(source);
    candidates.set(key, bucket);
  }
  const matched = new Set<string>();
  const inserts: ObservedFile[] = [];
  const updates: SourceUpdate[] = [];
  const moves: SourceUpdate[] = [];
  const probes: ObservedFile[] = [];
  const stats = emptyStats();
  for (const file of files.values()) {
    const source =
      byPath.get(file.absolutePath) ??
      candidates.get(identity(file) ?? "")?.shift() ??
      candidates.get(legacyIdentity(file) ?? "")?.shift();
    const moved = source !== undefined && source.absolutePath !== file.absolutePath;
    const changed =
      source !== undefined &&
      (source.fileSizeBytes !== file.fileSizeBytes ||
        source.modifiedAtMs !== file.modifiedAtMs ||
        source.inode !== file.inode);
    const change =
      source === undefined ? "new" : changed ? "changed" : moved ? "moved" : "unchanged";
    stats.discovered++;
    stats[change]++;
    if (source === undefined) inserts.push(file);
    else {
      matched.add(source.id);
      const update = { source, file, changed };
      if (moved) moves.push(update);
      if (changed || moved || source.device !== file.device || source.isAvailable !== true)
        updates.push(update);
    }
    if (
      source === undefined ||
      changed ||
      mode.mode === "full" ||
      (mode.userInitiated && snapshot.incomplete.has(source.id))
    )
      probes.push(file);
    else stats.skipped++;
  }
  const missing = snapshot.sources.filter((source) => !matched.has(source.id) && canRemove(source));
  stats.missing = missing.filter((source) => source.isAvailable !== false).length;
  stats.probesEnqueued = probes.length;
  const availability = snapshot.roots.flatMap((root) => {
    const observed = roots.get(root.id);
    if (observed === undefined) return [];
    const reason =
      observed.result === "complete"
        ? null
        : observed.result === "unavailable"
          ? "UNAVAILABLE"
          : "EMPTY";
    return root.isAvailable === (reason === null) && root.unavailableReason === reason
      ? []
      : [{ rootId: root.id, reason }];
  });
  return { inserts, updates, moves, missing, probes, availability, stats };
};
