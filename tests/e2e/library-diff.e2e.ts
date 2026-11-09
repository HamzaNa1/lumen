import {
  diff,
  type ObservedFile,
  type SourceSnapshot,
} from "../../apps/server/src/services/LibraryDiff";
import { expect, test } from "./support/server";

const file: ObservedFile = {
  rootId: "a",
  absolutePath: "/a/film.mp4",
  relativePath: "film.mp4",
  fileSizeBytes: 10,
  modifiedAtMs: 1,
  inode: "1",
  device: "1",
};
const source: SourceSnapshot = { ...file, id: "1", isAvailable: true };

test("a rename keeps the source and needs no probe", () => {
  const plan = diff(
    [
      {
        rootId: "a",
        result: "complete",
        files: new Map([
          ["/a/new.mp4", { ...file, absolutePath: "/a/new.mp4", relativePath: "new.mp4" }],
        ]),
        unreadable: [],
      },
    ],
    {
      sources: [source],
      incomplete: new Set(),
      roots: [{ id: "a", isAvailable: true, unavailableReason: null }],
    },
    { mode: "incremental", userInitiated: false },
  );
  expect(plan.moves.map((move) => move.source.id)).toEqual(["1"]);
  expect(plan.missing).toEqual([]);
  expect(plan.probes).toEqual([]);
});

const cases: Array<{
  name: string;
  files: ObservedFile[];
  sources?: SourceSnapshot[];
  result?: "complete" | "unavailable" | "empty-unconfirmed";
  unreadable?: string[];
  mode?: "incremental" | "full";
  userInitiated?: boolean;
  incomplete?: string[];
  expected: {
    new: number;
    changed: number;
    moved: number;
    unchanged: number;
    missing: number;
    probesEnqueued: number;
  };
}> = [
  {
    name: "legacy same-root rename retains its source while learning its device",
    sources: [{ ...source, device: null }],
    files: [{ ...file, absolutePath: "/a/new.mp4", relativePath: "new.mp4" }],
    expected: { new: 0, changed: 0, moved: 1, unchanged: 0, missing: 0, probesEnqueued: 0 },
  },
  {
    name: "legacy sources cannot move across roots without a known device",
    sources: [{ ...source, device: null }],
    files: [{ ...file, rootId: "b", absolutePath: "/b/film.mp4" }],
    expected: { new: 1, changed: 0, moved: 0, unchanged: 0, missing: 1, probesEnqueued: 1 },
  },
  {
    name: "move between roots",
    files: [{ ...file, rootId: "b", absolutePath: "/b/film.mp4" }],
    expected: { new: 0, changed: 0, moved: 1, unchanged: 0, missing: 0, probesEnqueued: 0 },
  },
  {
    name: "unavailable root cannot supply a move",
    result: "unavailable",
    files: [{ ...file, rootId: "b", absolutePath: "/b/film.mp4" }],
    expected: { new: 1, changed: 0, moved: 0, unchanged: 0, missing: 0, probesEnqueued: 1 },
  },
  {
    name: "same inode on another device is a new file",
    files: [{ ...file, absolutePath: "/a/new.mp4", device: "2" }],
    expected: { new: 1, changed: 0, moved: 0, unchanged: 0, missing: 1, probesEnqueued: 1 },
  },
  {
    name: "replacement at the same path",
    files: [{ ...file, inode: "2" }],
    expected: { new: 0, changed: 1, moved: 0, unchanged: 0, missing: 0, probesEnqueued: 1 },
  },
  {
    name: "deleted file",
    files: [],
    expected: { new: 0, changed: 0, moved: 0, unchanged: 0, missing: 1, probesEnqueued: 0 },
  },
  {
    name: "unreadable subfolder",
    unreadable: ["/a"],
    files: [],
    expected: { new: 0, changed: 0, moved: 0, unchanged: 0, missing: 0, probesEnqueued: 0 },
  },
  {
    name: "empty root may be unmounted",
    result: "empty-unconfirmed",
    files: [],
    expected: { new: 0, changed: 0, moved: 0, unchanged: 0, missing: 0, probesEnqueued: 0 },
  },
  {
    name: "full scan probes everything",
    mode: "full",
    files: [file],
    expected: { new: 0, changed: 0, moved: 0, unchanged: 1, missing: 0, probesEnqueued: 1 },
  },
  {
    name: "watcher leaves incomplete ingest alone",
    incomplete: ["1"],
    files: [file],
    expected: { new: 0, changed: 0, moved: 0, unchanged: 1, missing: 0, probesEnqueued: 0 },
  },
  {
    name: "user retries incomplete ingest",
    userInitiated: true,
    incomplete: ["1"],
    files: [file],
    expected: { new: 0, changed: 0, moved: 0, unchanged: 1, missing: 0, probesEnqueued: 1 },
  },
];
for (const entry of cases)
  test(entry.name, () => {
    const plan = diff(
      ["a", "b"].map((rootId) => ({
        rootId,
        result: rootId === "a" ? (entry.result ?? "complete") : "complete",
        files: new Map(
          entry.files
            .filter((file) => file.rootId === rootId)
            .map((file) => [file.absolutePath, file]),
        ),
        unreadable: entry.unreadable ?? [],
      })),
      {
        sources: entry.sources ?? [source],
        incomplete: new Set(entry.incomplete),
        roots: [
          { id: "a", isAvailable: true, unavailableReason: null },
          { id: "b", isAvailable: true, unavailableReason: null },
        ],
      },
      { mode: entry.mode ?? "incremental", userInitiated: entry.userInitiated ?? false },
    );
    expect(plan.stats).toMatchObject(entry.expected);
  });

test("path matching reserves hard links before choosing the oldest unmatched source", () => {
  const renamed = { ...file, absolutePath: "/a/new.mp4" };
  const plan = diff(
    [
      {
        rootId: "a",
        result: "complete",
        files: new Map([
          [renamed.absolutePath, renamed],
          [file.absolutePath, file],
        ]),
        unreadable: [],
      },
    ],
    {
      sources: [
        { ...source, id: "3", absolutePath: "/a/third.mp4" },
        source,
        { ...source, id: "2", absolutePath: "/a/second.mp4" },
      ],
      incomplete: new Set(),
      roots: [],
    },
    { mode: "incremental", userInitiated: false },
  );
  expect(plan.moves.map((move) => move.source.id)).toEqual(["2"]);
  expect(plan.missing.map((source) => source.id)).toEqual(["3"]);
});
