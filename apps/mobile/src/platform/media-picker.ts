import { MAX_ORIGINAL_IMAGE_BYTES, originalImageMime } from "./media-image";
import * as ImagePicker from "expo-image-picker";
import type { LocalUploadImage } from "./media-client";

const fictionalPng =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAYUlEQVRYhe2SQQkAQRDD6iKKqmb9/0/EPcJAIQLS0PB6mugGbED1iuxCvUt0AzagekV2od4lugEbUL0iu1DvEt2ADahekV2od4luwAZUr8gu1LtEN2ADqldkF+pdohv85AONejhbMcvf8gAAAABJRU5ErkJggg==";
function decodeBase64(value: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = 0,
    accumulated = 0;
  const bytes: number[] = [];
  for (const character of value.replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("The fictional image fixture is invalid.");
    accumulated = (accumulated << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulated >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}
export function generatedFictionalImage(): LocalUploadImage {
  return {
    bytes: decodeBase64(fictionalPng),
    mimeType: "image/png",
    label: "Generated fictional pitch colour PNG · no people",
    uri: `data:image/png;base64,${fictionalPng}`,
  };
}
async function imageFromResult(
  result: ImagePicker.ImagePickerResult,
): Promise<LocalUploadImage | null> {
  if (result.canceled || !result.assets.length) return null;
  const asset = result.assets[0];
  if (asset.fileSize !== undefined && asset.fileSize > MAX_ORIGINAL_IMAGE_BYTES)
    throw new Error("Choose a JPEG, PNG or HEIC no larger than 15 MiB.");
  let buffer: ArrayBuffer;
  if (asset.file) buffer = await asset.file.arrayBuffer();
  else {
    if (
      !/^(?:file:|content:|blob:|data:image\/(?:png|jpeg|heic);)/.test(
        asset.uri,
      )
    )
      throw new Error("The picker did not return a supported local image.");
    buffer = await (await fetch(asset.uri)).arrayBuffer();
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ORIGINAL_IMAGE_BYTES)
    throw new Error("Choose a JPEG, PNG or HEIC no larger than 15 MiB.");
  const mimeType = originalImageMime(bytes);
  return {
    bytes,
    mimeType,
    label: "Selected local image · still private",
    uri: asset.uri,
  };
}
/** Invoke directly from a user gesture; no camera, video or broad library enumeration. */
export async function pickMediaImage(): Promise<LocalUploadImage | null> {
  return imageFromResult(
    await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      allowsMultipleSelection: false,
      quality: 1,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      exif: false,
      base64: false,
      shouldDownloadFromNetwork: false,
    }),
  );
}
/** Android may recreate its activity after the OS picker; never silently upload the recovered file. */
export async function recoverPickedMediaImage(): Promise<LocalUploadImage | null> {
  const result = await ImagePicker.getPendingResultAsync();
  if (!result || "code" in result) return null;
  return imageFromResult(result);
}
