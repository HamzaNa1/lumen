import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

interface Element {
  readonly id: number;
  readonly offset: number;
  readonly data: number;
  readonly end: number;
}

const elements = (bytes: Uint8Array, start = 0, end = bytes.length): Element[] => {
  const vint = (offset: number, keepMarker: boolean): { value: number; width: number } => {
    const first = bytes[offset] ?? 0;
    let width = 1;
    while (width <= 8 && (first & (0x80 >> (width - 1))) === 0) width += 1;
    expect(width).toBeLessThanOrEqual(8);
    let value = keepMarker ? first : first & (0xff >> width);
    for (let index = 1; index < width; index += 1)
      value = value * 256 + (bytes[offset + index] ?? 0);
    return { value, width };
  };
  const result: Element[] = [];
  for (let offset = start; offset < end;) {
    const id = vint(offset, true);
    const size = vint(offset + id.width, false);
    const data = offset + id.width + size.width;
    const next = data + size.value;
    expect(next).toBeLessThanOrEqual(end);
    result.push({ id: id.value, offset, data, end: next });
    offset = next;
  }
  return result;
};

const child = (bytes: Uint8Array, parent: Element, id: number): Element => {
  const found = elements(bytes, parent.data, parent.end).find((element) => element.id === id);
  if (found === undefined) throw new Error(`Missing WebM element ${id.toString(16)}`);
  return found;
};

const uint = (bytes: Uint8Array, element: Element): number =>
  bytes.subarray(element.data, element.end).reduce((value, byte) => value * 256 + byte, 0);

test("the WebM playback fixture has a front-loaded, valid video seek index", async () => {
  // Remux without re-encoding: ffmpeg -i playback.webm -map 0 -c copy -cues_to_front 1 output.webm
  const bytes = await readFile(new URL("../fixtures/playback.webm", import.meta.url));
  const segment = elements(bytes).find((element) => element.id === 0x18538067);
  if (segment === undefined) throw new Error("Missing WebM segment");
  const contents = elements(bytes, segment.data, segment.end);
  const clusters = contents.filter((element) => element.id === 0x1f43b675);
  const cues = child(bytes, segment, 0x1c53bb6b);
  expect(clusters.length).toBeGreaterThan(1);
  // WebKit must know the index before a cold resume asks it to seek. A tail index requires
  // a second seek while the first HTTP range response may still be arriving.
  expect(cues.end).toBeLessThanOrEqual(clusters[0]?.offset ?? 0);
  const seekHead = child(bytes, segment, 0x114d9b74);
  const indexEntry = elements(bytes, seekHead.data, seekHead.end).find(
    (entry) => uint(bytes, child(bytes, entry, 0x53ab)) === cues.id,
  );
  if (indexEntry === undefined) throw new Error("Missing WebM cue index reference");
  expect(uint(bytes, child(bytes, indexEntry, 0x53ac))).toBe(cues.offset - segment.data);

  const clusterPositions = new Set(clusters.map((cluster) => cluster.offset - segment.data));
  const points = elements(bytes, cues.data, cues.end);
  expect(points.length).toBeGreaterThan(1);
  const times: number[] = [];
  for (const point of points) {
    expect(point.id).toBe(0xbb);
    times.push(uint(bytes, child(bytes, point, 0xb3)));
    const track = child(bytes, point, 0xb7);
    expect(uint(bytes, child(bytes, track, 0xf7))).toBe(1);
    expect(clusterPositions.has(uint(bytes, child(bytes, track, 0xf1)))).toBe(true);
  }
  expect(times[0]).toBe(0);
  expect(times.at(-1)).toBeGreaterThan(15_000);
  expect(times.every((time, index) => index === 0 || time > (times[index - 1] ?? 0))).toBe(true);
});
