import { describe, expect, it } from "vitest";
import {
  assertOriginalImage,
  MAX_ORIGINAL_IMAGE_BYTES,
  originalImageMime,
} from "./media-image";
function ftyp(major: string, compatible: string[] = []) {
  const bytes = new Uint8Array(16 + compatible.length * 4),
    view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  const put = (at: number, value: string) =>
    [...value].forEach((character, index) => {
      bytes[at + index] = character.charCodeAt(0);
    });
  put(4, "ftyp");
  put(8, major);
  compatible.forEach((value, index) => put(16 + index * 4, value));
  return bytes;
}
describe("original image byte format boundary", () => {
  it("derives JPEG/PNG and HEVC still-image MIME from bounded bytes without trusting names or picker metadata", () => {
    expect(originalImageMime(Uint8Array.from([255, 216, 255]))).toBe(
      "image/jpeg",
    );
    expect(
      originalImageMime(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ).toBe("image/png");
    expect(originalImageMime(ftyp("heic", ["mif1"]))).toBe("image/heic");
    expect(originalImageMime(ftyp("heix"))).toBe("image/heic");
    expect(originalImageMime(ftyp("mif1", ["heic", "miaf"]))).toBe(
      "image/heic",
    );
  });
  it("refuses sequence, AVIF and unsupported HEIF brands even when another brand claims HEIC", () => {
    for (const brand of ["hevc", "hevx", "msf1", "avif", "avis"])
      expect(() => originalImageMime(ftyp("heic", [brand]))).toThrow(
        /sequence|sequences/,
      );
    for (const bytes of [
      ftyp("mif1"),
      ftyp("avif", ["heic"]),
      ftyp("av01"),
      ftyp("unknown"),
    ])
      expect(() => originalImageMime(bytes)).toThrow(/supported/);
  });
  it("refuses malformed, truncated, extended or excessive ftyp boxes before any upload", () => {
    const valid = ftyp("heic", ["mif1"]);
    for (const size of [0, 1, 12, 17, 24, 4097]) {
      const invalid = Uint8Array.from(valid);
      new DataView(invalid.buffer).setUint32(0, size);
      expect(() => originalImageMime(invalid)).toThrow(/supported/);
    }
    const excessive = new Uint8Array(4100);
    excessive.set(ftyp("heic"));
    new DataView(excessive.buffer).setUint32(0, 4100);
    expect(() => originalImageMime(excessive)).toThrow(/supported/);
    expect(() => originalImageMime(valid.subarray(0, 15))).toThrow(/supported/);
  });
  it("does not treat a PNG prefix or an APNG as a still PNG", () => {
    expect(() => originalImageMime(Uint8Array.from([137, 80, 78, 71]))).toThrow(
      /supported/,
    );
    const apng = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(() => originalImageMime(apng)).toThrow(/Animated/);
  });
  it("rejects empty/oversized originals and a declared MIME that conflicts with the original bytes", () => {
    expect(() => originalImageMime(new Uint8Array())).toThrow(/15 MiB/);
    expect(() =>
      originalImageMime(new Uint8Array(MAX_ORIGINAL_IMAGE_BYTES + 1)),
    ).toThrow(/15 MiB/);
    expect(() =>
      assertOriginalImage({ bytes: ftyp("heic"), mimeType: "image/jpeg" }),
    ).toThrow(/does not match/);
    expect(() =>
      assertOriginalImage({ bytes: ftyp("heic"), mimeType: "image/heic" }),
    ).not.toThrow();
  });
});
