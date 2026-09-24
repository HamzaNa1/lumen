export interface ImageInfo {
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
}

export const imageInfo = (bytes: Uint8Array): ImageInfo | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      const segmentLength = view.getUint16(offset + 2);
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3 && segmentLength >= 7) {
        return { mimeType: "image/jpeg", height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      if (segmentLength < 2) return null;
      offset += segmentLength + 2;
    }
  }
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
    const kind = tag(12);
    if (kind === "VP8X") return { mimeType: "image/webp", width: 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16), height: 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16) };
    if (kind === "VP8L" && bytes[20] === 0x2f) return { mimeType: "image/webp", width: 1 + view.getUint8(21) + ((view.getUint8(22) & 0x3f) << 8), height: 1 + (view.getUint8(22) >> 6) + (view.getUint8(23) << 2) + ((view.getUint8(24) & 0x0f) << 10) };
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { mimeType: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return null;
};
