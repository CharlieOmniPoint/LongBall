import { describe, expect, it } from "vitest";
import type {
  BrandingDto,
  LogoReference,
} from "@longball/application/branding";
import {
  BrandMediaClient,
  assertBrandingResponse,
  readCurrentBrandImage,
  type PreparedLogoUpload,
} from "./brand-media-client";
import type { LocalUploadImage } from "./media-client";
const scope = {
  teamId: "roma",
  authoritySeasonId: "2026-27",
  clubId: "fictional-club",
  role: "manager" as const,
};
const team: LogoReference = {
  assetId: "team-logo",
  revision: 2,
  kind: "team_logo",
  clubId: "fictional-club",
  teamId: "roma",
};
const club: LogoReference = {
  assetId: "club-logo",
  revision: 1,
  kind: "club_logo",
  clubId: "fictional-club",
  teamId: null,
};
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const image: LocalUploadImage = {
  bytes: png,
  mimeType: "image/png",
  label: "Fictional logo test bytes",
  uri: "data:image/png;base64,fictional-only",
};
const prepared: PreparedLogoUpload = {
  kind: "prepared-logo-upload",
  uploadId: "logo-upload",
  asset: team,
  uploadToken: "write-only-capability",
  expiresAtMs: 1_900_000_000_000,
  maxBytes: 15 * 1024 * 1024,
};
function dto(): BrandingDto {
  return {
    kind: "team-branding",
    teamId: "roma",
    clubId: "fictional-club",
    authoritySeasonId: "2026-27",
    policyVersion: "logo-rights-v1",
    club: {
      id: "fictional-club",
      name: "Fictional club",
      slotVersion: 4,
      logo: club,
    },
    team: {
      id: "roma",
      name: "Roma",
      ageGroup: "U10",
      slotVersion: 3,
      logo: team,
    },
    effective: { source: "team", logo: team },
    canWriteClub: false,
    canWriteTeam: true,
    assets: [],
  };
}
describe("kind-scoped logo HTTP client", () => {
  it("prepares team and club logos with distinct ancestry and authority-only season in URL", async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    const client = new BrandMediaClient(
      "https://api.example/v1",
      scope,
      async (url, options) => {
        calls.push({ url, options });
        return Response.json(prepared);
      },
    );
    await client.prepare({
      requestId: "stable-logo",
      target: { kind: "team_logo", teamId: "roma" },
      image,
      sha256: "a".repeat(64),
    });
    expect(calls[0].url).toBe(
      "https://api.example/v1/teams/roma/branding/team_logo/uploads/prepare?seasonId=2026-27",
    );
    expect(JSON.parse(String(calls[0].options.body))).toEqual({
      kind: "team_logo",
      teamId: "roma",
      mimeType: "image/png",
      byteSize: png.byteLength,
      sha256: "a".repeat(64),
      policyAcknowledged: true,
    });
    expect(new Headers(calls[0].options.headers).get("Idempotency-Key")).toBe(
      "stable-logo",
    );
    expect(new Headers(calls[0].options.headers).get("X-Longball-Role")).toBe(
      "manager",
    );
    const admin = new BrandMediaClient(
      "/",
      { ...scope, role: "administrator" },
      async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ...prepared, asset: club });
      },
    );
    await admin.prepare({
      requestId: "stable-club",
      target: { kind: "club_logo", clubId: "fictional-club" },
      image,
      sha256: "b".repeat(64),
    });
    expect(JSON.parse(String(calls[1].options.body))).toMatchObject({
      kind: "club_logo",
      clubId: "fictional-club",
    });
    for (const { options } of calls)
      for (const forbidden of [
        "requestId",
        "ownerId",
        "matchId",
        "seasonId",
        "uploadToken",
      ])
        expect(JSON.parse(String(options.body))).not.toHaveProperty(forbidden);
  });
  it("rejects contradictory kind/owner fields and mismatched preparation receipts before any byte upload", async () => {
    let requests = 0;
    const client = new BrandMediaClient("/", scope, async () => {
      requests += 1;
      return Response.json({
        ...prepared,
        asset: { ...team, clubId: "another-club", teamId: "another-team" },
      });
    });
    await expect(
      client.prepare({
        requestId: "stable",
        target: { kind: "team_logo", teamId: "other-team" },
        image,
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("outside");
    await expect(
      client.prepare({
        requestId: "stable",
        target: {
          kind: "team_logo",
          teamId: "roma",
          clubId: "forged",
        } as never,
        image,
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("outside");
    expect(requests).toBe(0);
    await expect(
      client.prepare({
        requestId: "stable",
        target: { kind: "team_logo", teamId: "roma" },
        image,
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("differs");
    expect(requests).toBe(1);
  });
  it("sends exact bytes with private capability headers and stable retry keys, refusing a different processed revision", async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    const client = new BrandMediaClient("/", scope, async (url, options) => {
      calls.push({ url, options });
      return Response.json(
        options.method === "PUT"
          ? {
              uploadId: prepared.uploadId,
              status: "uploaded",
              byteSize: png.byteLength,
            }
          : {
              kind: "processed-logo-upload",
              uploadId: prepared.uploadId,
              asset: { ...team, revision: team.revision + 1 },
              status: "processed",
              width: 64,
              height: 32,
            },
      );
    });
    await client.upload(prepared, image, "same-request");
    await client.upload(prepared, image, "same-request");
    expect(new Uint8Array(calls[0].options.body as ArrayBuffer)).toEqual(png);
    for (const call of calls) {
      expect(call.url).not.toContain(prepared.uploadToken);
      expect(
        new Headers(call.options.headers).get("X-Media-Upload-Token"),
      ).toBe(prepared.uploadToken);
      expect(new Headers(call.options.headers).get("Idempotency-Key")).toBe(
        "same-request-upload",
      );
    }
    await expect(client.complete(prepared, "same-request")).rejects.toThrow(
      "differs from the original",
    );
    expect(new Headers(calls[2].options.headers).get("Idempotency-Key")).toBe(
      "same-request-complete",
    );
  });
  it("surfaces missing scanner without manufacturing publication or changing any logo reference", async () => {
    const original = JSON.stringify(prepared);
    const client = new BrandMediaClient("/", scope, async () =>
      Response.json(
        {
          code: "SCANNER_REQUIRED",
          message:
            "Scanning is unavailable. The uploaded logo remains private.",
        },
        { status: 503 },
      ),
    );
    await expect(client.complete(prepared, "same-request")).rejects.toThrow(
      "remains private",
    );
    expect(JSON.stringify(prepared)).toBe(original);
  });
  it("reads only authenticated current-revision PNG derivatives and rejects non-PNG bodies", async () => {
    const urls: string[] = [];
    const client = new BrandMediaClient("/", scope, async (url, options) => {
      urls.push(url);
      expect(new Headers(options.headers).get("Accept")).toBe("image/png");
      return new Response(png, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, no-store",
        },
      });
    });
    expect(await client.image(team, "own", "display")).toEqual(png);
    expect(urls[0]).toBe(
      "/v1/teams/roma/branding/assets/team-logo/revisions/2/display?seasonId=2026-27&mode=own",
    );
    const wrong = new BrandMediaClient(
      "/",
      scope,
      async () =>
        new Response("not a PNG", { headers: { "Content-Type": "image/png" } }),
    );
    await expect(wrong.image(team, "published")).rejects.toThrow("invalid");
  });
  it("rejects credential-bearing API addresses before creating the client", () => {
    const neverFetch = async () => {
      throw new Error("Must not fetch");
    };
    for (const address of [
      "https://user:secret@example.test",
      "https://example.test?token=value",
      "javascript:alert(1)",
    ])
      expect(() => new BrandMediaClient(address, scope, neverFetch)).toThrow();
  });
});
describe("brand DTO attachment and asynchronous image authority", () => {
  it("accepts team override then live club inheritance and neutral fallback without changing source data", () => {
    const value = dto(),
      before = JSON.stringify(value);
    expect(() => assertBrandingResponse(value, scope)).not.toThrow();
    expect(JSON.stringify(value)).toBe(before);
    value.team.logo = null;
    value.effective = { source: "club", logo: club };
    expect(() => assertBrandingResponse(value, scope)).not.toThrow();
    value.club.logo = null;
    value.effective = { source: "neutral", logo: null };
    expect(() => assertBrandingResponse(value, scope)).not.toThrow();
  });
  it("refuses another scope, forged ancestry, stale effective fallback and season-bearing logo references", () => {
    for (const value of [
      { ...dto(), teamId: "different-team" },
      { ...dto(), authoritySeasonId: "another-season" },
      { ...dto(), effective: { source: "club", logo: club } },
      {
        ...dto(),
        team: { ...dto().team, logo: { ...team, teamId: "other-team" } },
      },
      {
        ...dto(),
        club: { ...dto().club, logo: { ...club, seasonId: "forbidden" } },
      },
    ])
      expect(() => assertBrandingResponse(value, scope)).toThrow("discarded");
  });
  it("does not return private bytes when current scope closes while the HTTP response is delayed", async () => {
    let open = true,
      reads = 0,
      release!: (bytes: Uint8Array) => void;
    const deferred = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    const operation = readCurrentBrandImage(
      {
        image: async () => {
          reads += 1;
          return deferred;
        },
      },
      team,
      "own",
      "display",
      async () => {
        if (!open) throw new Error("Current authority closed");
      },
    );
    await Promise.resolve();
    expect(reads).toBe(1);
    open = false;
    release(png);
    await expect(operation).rejects.toThrow("Current authority closed");
  });
  it("refuses before network reads when already locked and checks current authority again after successful bytes", async () => {
    let reads = 0,
      checks = 0;
    const reader = {
      image: async () => {
        reads += 1;
        return png;
      },
    };
    await expect(
      readCurrentBrandImage(
        reader,
        team,
        "published",
        "thumbnail",
        async () => {
          throw new Error("Locked");
        },
      ),
    ).rejects.toThrow("Locked");
    expect(reads).toBe(0);
    expect(
      await readCurrentBrandImage(
        reader,
        team,
        "published",
        "thumbnail",
        async () => {
          checks += 1;
        },
      ),
    ).toEqual(png);
    expect(checks).toBe(2);
  });
  it("uses the same bounded original HEIC MIME and unchanged bytes for seasonless logo upload", async () => {
    const bytes = Uint8Array.from([
      0, 0, 0, 20, 102, 116, 121, 112, 104, 101, 105, 120, 0, 0, 0, 0, 109, 105,
      102, 49,
    ]);
    const heic: LocalUploadImage = {
      bytes,
      mimeType: "image/heic",
      label: "Fictional transport header",
      uri: "file:///fictional.heic",
    };
    const calls: RequestInit[] = [];
    const client = new BrandMediaClient("/", scope, async (_url, options) => {
      calls.push(options);
      return Response.json(
        calls.length === 1
          ? prepared
          : {
              uploadId: prepared.uploadId,
              status: "uploaded",
              byteSize: bytes.length,
            },
      );
    });
    await client.prepare({
      requestId: "heic-logo-original",
      target: { kind: "team_logo", teamId: scope.teamId },
      image: heic,
      sha256: "b".repeat(64),
    });
    await client.upload(prepared, heic, "heic-logo-original");
    expect(JSON.parse(String(calls[0].body))).toEqual({
      kind: "team_logo",
      teamId: scope.teamId,
      mimeType: "image/heic",
      byteSize: bytes.length,
      sha256: "b".repeat(64),
      policyAcknowledged: true,
    });
    expect(new Headers(calls[1].headers).get("Content-Type")).toBe(
      "image/heic",
    );
    expect(new Uint8Array(calls[1].body as ArrayBuffer)).toEqual(bytes);
  });
});
