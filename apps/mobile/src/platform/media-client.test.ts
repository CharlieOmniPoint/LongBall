import { describe, expect, it } from "vitest";
import { syntheticCommunityActors } from "@longball/application/community";
import {
  MediaUploadClient,
  type LocalUploadImage,
  type RemotePreparedUpload,
} from "./media-client";

const actor = syntheticCommunityActors().player;
const image: LocalUploadImage = {
  bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
  mimeType: "image/png",
  label: "Fictional test bytes",
  uri: "data:image/png;base64,fixture-only",
};
const prepared: RemotePreparedUpload = {
  uploadId: "upload-id",
  photoId: "photo-id",
  uploadToken: "private-write-capability",
  expiresAtMs: 1234,
  maxBytes: 15 * 1024 * 1024,
  displayRevision: 1,
};

describe("authenticated media transport", () => {
  it("prepares with role/scope/version and retains explicit request identity without receiving auth tokens as props", async () => {
    let call: { url: string; options: RequestInit } | null = null;
    const client = new MediaUploadClient(
      "https://longball.example/v1",
      actor,
      async (url, options) => {
        call = { url, options };
        return Response.json(prepared);
      },
    );
    expect(
      await client.prepare({
        requestId: "stable-request",
        matchId: "fictional-match",
        image,
        sha256: "a".repeat(64),
        caption: "Fictional image",
      }),
    ).toEqual(prepared);
    const captured = call! as { url: string; options: RequestInit };
    expect(captured.url).toBe(
      `https://longball.example/v1/teams/${actor.teamId}/media/uploads/prepare?seasonId=${actor.seasonId}`,
    );
    expect(captured.options).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: {
        "Idempotency-Key": "stable-request",
        "X-Longball-Role": "player",
        "X-Api-Contract-Version": "longball.events/1.1",
      },
    });
    expect(JSON.parse(String(captured.options.body))).toMatchObject({
      byteSize: 8,
      policyAcknowledged: true,
      caption: "Fictional image",
    });
    expect(new Headers(captured.options.headers).has("Authorization")).toBe(
      false,
    );
  });

  it("sends the actual bytes and write capability only in a header, with stable retry keys", async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    const client = new MediaUploadClient("/", actor, async (url, options) => {
      calls.push({ url, options });
      return Response.json({ status: "uploaded" });
    });
    await client.upload(prepared, image, "stable");
    await client.upload(prepared, image, "stable");
    expect(calls[0].options.method).toBe("PUT");
    expect(new Uint8Array(calls[0].options.body as ArrayBuffer)).toEqual(
      image.bytes,
    );
    expect(calls[0].url).not.toContain(prepared.uploadToken);
    expect(
      new Headers(calls[0].options.headers).get("X-Media-Upload-Token"),
    ).toBe(prepared.uploadToken);
    expect(new Headers(calls[0].options.headers).get("Idempotency-Key")).toBe(
      "stable-upload",
    );
    expect(new Headers(calls[1].options.headers).get("Idempotency-Key")).toBe(
      "stable-upload",
    );
  });

  it("surfaces the API’s scanner-required reason and does not describe a refused completion as saved", async () => {
    const client = new MediaUploadClient("/", actor, async () =>
      Response.json(
        {
          code: "SCANNER_REQUIRED",
          message:
            "Image safety scanning is not configured. The original remains private.",
          retryable: false,
        },
        { status: 503 },
      ),
    );
    await expect(client.complete(prepared, "stable")).rejects.toThrow(
      /original remains private/,
    );
  });

  it("fetches private gallery/review bytes only through the authenticated gateway and refuses non-images", async () => {
    const urls: string[] = [];
    const client = new MediaUploadClient("/", actor, async (url) => {
      urls.push(url);
      return new Response(Uint8Array.from([255, 216, 255]), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, no-store",
        },
      });
    });
    expect(await client.image("photo-id", 2, "thumbnail", "gallery")).toEqual(
      Uint8Array.from([255, 216, 255]),
    );
    await client.image("photo-id", 2, "display", "review");
    expect(urls[0]).toContain("/photos/photo-id/thumbnail?");
    expect(urls[0]).toContain("&mode=gallery&revision=2");
    expect(urls[1]).toContain("&mode=review&revision=2");
    const denied = new MediaUploadClient("/", actor, async () =>
      Response.json({ message: "Denied" }, { status: 404 }),
    );
    await expect(denied.image("photo-id", 2)).rejects.toThrow(
      /no longer available/,
    );
  });

  it("rejects credential-bearing or invalid service addresses before issuing a request", () => {
    const neverFetch = async () => {
      throw new Error("Must not request");
    };
    expect(
      () =>
        new MediaUploadClient(
          "https://user:password@wrong.example",
          actor,
          neverFetch,
        ),
    ).toThrow(/without credentials/);
    expect(
      () => new MediaUploadClient("javascript:alert(1)", actor, neverFetch),
    ).toThrow(/HTTP/);
    expect(
      () =>
        new MediaUploadClient(
          "https://longball.example?token=private",
          actor,
          neverFetch,
        ),
    ).toThrow(/without credentials/);
  });
  it("transports recognized HEIC originals unchanged with original MIME, hash and retry identity", async () => {
    const bytes = Uint8Array.from([
      0, 0, 0, 20, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0, 109, 105,
      102, 49,
    ]);
    const heic: LocalUploadImage = {
      bytes,
      mimeType: "image/heic",
      label: "Fictional header transport fixture",
      uri: "file:///fictional.heic",
    };
    const calls: RequestInit[] = [];
    const client = new MediaUploadClient("/", actor, async (_url, options) => {
      calls.push(options);
      return Response.json(prepared);
    });
    await client.prepare({
      requestId: "heic-original",
      matchId: "fictional-match",
      image: heic,
      sha256: "b".repeat(64),
      caption: "Fictional",
    });
    await client.upload(prepared, heic, "heic-original");
    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      mimeType: "image/heic",
      byteSize: bytes.length,
      sha256: "b".repeat(64),
    });
    expect(new Headers(calls[1].headers).get("Content-Type")).toBe(
      "image/heic",
    );
    expect(new Uint8Array(calls[1].body as ArrayBuffer)).toEqual(bytes);
    expect(new Headers(calls[1].headers).get("Idempotency-Key")).toBe(
      "heic-original-upload",
    );
  });
  it("does not send image bytes with a forged declared MIME", () => {
    let sent = false;
    const client = new MediaUploadClient("/", actor, async () => {
      sent = true;
      return Response.json(prepared);
    });
    expect(() =>
      client.prepare({
        requestId: "forged",
        matchId: "fictional-match",
        image: { ...image, mimeType: "image/heic" },
        sha256: "b".repeat(64),
        caption: "",
      }),
    ).toThrow(/does not match/);
    expect(sent).toBe(false);
  });
});
