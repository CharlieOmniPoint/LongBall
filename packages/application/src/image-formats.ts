/** Original upload format gate. Server scanning and bounded decoding remain authoritative. */
export type OriginalImageMime = "image/png" | "image/jpeg" | "image/heic";
export const MAX_ORIGINAL_IMAGE_BYTES = 15 * 1024 * 1024;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const read32 = (bytes: Uint8Array, at: number) =>
  bytes[at] * 0x1000000 +
  bytes[at + 1] * 0x10000 +
  bytes[at + 2] * 0x100 +
  bytes[at + 3];
const four = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(...bytes.subarray(at, at + 4));
const unsupported = () =>
  new Error(
    "Choose a still JPEG, PNG or supported single-image HEIC. Animated images, HEIC sequences and other formats are not supported.",
  );
export function originalImageMime(bytes: Uint8Array): OriginalImageMime {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_ORIGINAL_IMAGE_BYTES
  )
    throw new Error("Choose a JPEG, PNG or HEIC no larger than 15 MiB.");
  if (pngSignature.every((byte, index) => bytes[index] === byte)) {
    // An APNG has an animation-control chunk before its image data. Do not enable it as a still PNG.
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = read32(bytes, offset),
        type = four(bytes, offset + 4);
      if (type === "acTL") throw unsupported();
      if (length > bytes.length - offset - 12) break; // The decoder rejects malformed/truncated chunks.
      offset += length + 12;
      if (type === "IEND") break;
    }
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (bytes.length >= 16 && four(bytes, 4) === "ftyp") {
    const size = read32(bytes, 0);
    if (size < 16 || size > 4096 || size > bytes.length || size % 4 !== 0)
      throw unsupported();
    const major = four(bytes, 8);
    if (!["heic", "heix", "mif1"].includes(major)) throw unsupported();
    const brands = [major];
    for (let offset = 16; offset < size; offset += 4)
      brands.push(four(bytes, offset));
    if (
      brands.some((brand) =>
        ["hevc", "hevx", "msf1", "avif", "avis"].includes(brand),
      ) ||
      !brands.some((brand) => brand === "heic" || brand === "heix")
    )
      throw unsupported();
    return "image/heic";
  }
  throw unsupported();
}
/** Prevent callers or a picker label from substituting a MIME or extension for the original bytes. */
export function assertOriginalImage(image: {
  bytes: Uint8Array;
  mimeType: OriginalImageMime;
}): void {
  if (originalImageMime(image.bytes) !== image.mimeType)
    throw new Error(
      "The image MIME does not match its original bytes. Choose the file again; it has not been uploaded.",
    );
}
