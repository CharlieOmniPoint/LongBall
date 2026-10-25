import { assertOriginalImage } from "./media-image";
import type {
  BrandingDto,
  LogoReference,
  BrandingCommand,
  BrandKind,
} from "@longball/application/branding";
import { WIRE_CONTRACT_VERSION } from "@longball/application/sync";
import type { LocalUploadImage, MediaAuthenticatedFetch } from "./media-client";

export interface BrandClientScope {
  teamId: string;
  authoritySeasonId: string;
  clubId?: string;
  role: "administrator" | "manager" | "player" | "spectator";
}
export interface PreparedLogoUpload {
  kind: "prepared-logo-upload";
  uploadId: string;
  asset: LogoReference;
  uploadToken: string;
  expiresAtMs: number;
  maxBytes: number;
}
export interface ProcessedLogoUpload {
  kind: "processed-logo-upload";
  uploadId: string;
  asset: LogoReference;
  status: "processed";
  width: number;
  height: number;
}
export type LogoUploadTarget =
  | { kind: "club_logo"; clubId: string }
  | { kind: "team_logo"; teamId: string };
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 150 &&
  !/[^A-Za-z0-9_-]/.test(value);
export function logoReferenceKey(asset: LogoReference) {
  return JSON.stringify([
    asset.assetId,
    asset.revision,
    asset.kind,
    asset.clubId,
    asset.teamId,
  ]);
}
/** Brand assets use their own kind-dependent ancestry; a game/photo actor is never fabricated. */
export class BrandMediaClient {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly scope: BrandClientScope,
    private readonly authenticatedFetch: MediaAuthenticatedFetch,
  ) {
    const supplied = baseUrl.trim();
    if (!supplied || /[\u0000-\u001F]/.test(supplied))
      throw new Error("A valid LongBall API URL is required.");
    if (supplied !== "/") {
      const parsed = new URL(supplied);
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error(
          "Use an HTTP(S) API URL without credentials, query or fragment.",
        );
    }
    if (
      !identifier(scope.teamId) ||
      !identifier(scope.authoritySeasonId) ||
      !["administrator", "manager", "player", "spectator"].includes(scope.role)
    )
      throw new Error(
        "Branding requires the current authorised team, season and selected role.",
      );
    this.baseUrl =
      supplied === "/" ? "" : supplied.replace(/\/$/, "").replace(/\/v1$/, "");
  }
  private url(path = "", query = "") {
    return `${this.baseUrl}/v1/teams/${encodeURIComponent(this.scope.teamId)}/branding${path ? `/${path}` : ""}?seasonId=${encodeURIComponent(this.scope.authoritySeasonId)}${query}`;
  }
  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("X-Longball-Role", this.scope.role);
    headers.set("X-Api-Contract-Version", WIRE_CONTRACT_VERSION);
    return headers;
  }
  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await this.authenticatedFetch(this.url(path), {
        ...init,
        signal: abort.signal,
        redirect: "error",
        credentials: "omit",
        headers: this.headers(init.headers),
      });
      const text = await response.text();
      if (text.length > 256_000)
        throw new Error("The branding response exceeded its allowed size.");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(
          `The logo service did not return a valid response (HTTP${response.status}).`,
        );
      }
      if (!response.ok) {
        const failure =
          body && typeof body === "object" && "error" in body
            ? body.error
            : body;
        const message =
          failure &&
          typeof failure === "object" &&
          "message" in failure &&
          typeof failure.message === "string" &&
          failure.message.length <= 400
            ? failure.message
            : `Logo request failed (HTTP${response.status}).`;
        throw new Error(message);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }
  async read() {
    const value = await this.request<BrandingDto>("");
    assertBrandingResponse(value, this.scope);
    return value;
  }
  async prepare(input: {
    requestId: string;
    target: LogoUploadTarget;
    image: LocalUploadImage;
    sha256: string;
  }) {
    assertOriginalImage(input.image);
    const target = input.target;
    if (
      !identifier(input.requestId) ||
      !["image/png", "image/jpeg", "image/heic"].includes(
        input.image.mimeType,
      ) ||
      input.image.bytes.byteLength < 1 ||
      input.image.bytes.byteLength > 15 * 1024 * 1024 ||
      !/^[a-fA-F0-9]{64}$/.test(input.sha256)
    )
      throw new Error(
        "Choose bounded JPEG, PNG or HEIC logo bytes with a stable request identity and SHA-256.",
      );
    if (
      !target ||
      !["club_logo", "team_logo"].includes(target.kind) ||
      Object.keys(target).some(
        (key) =>
          !["kind", target.kind === "club_logo" ? "clubId" : "teamId"].includes(
            key,
          ),
      ) ||
      (target.kind === "club_logo"
        ? !identifier(target.clubId)
        : !identifier(target.teamId) || target.teamId !== this.scope.teamId)
    )
      throw new Error("The logo target is outside this current scope.");
    const ancestry =
      target.kind === "club_logo"
        ? { kind: target.kind, clubId: target.clubId }
        : { kind: target.kind, teamId: target.teamId };
    const body = {
      ...ancestry,
      mimeType: input.image.mimeType,
      byteSize: input.image.bytes.byteLength,
      sha256: input.sha256,
      policyAcknowledged: true,
    };
    const result = await this.request<PreparedLogoUpload>(
      `${target.kind}/uploads/prepare`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.requestId,
        },
        body: JSON.stringify(body),
      },
    );
    this.assertAsset(
      result.asset,
      target.kind,
      target.kind === "club_logo" ? target.clubId : null,
    );
    if (
      result.kind !== "prepared-logo-upload" ||
      !identifier(result.uploadId) ||
      typeof result.uploadToken !== "string" ||
      !result.uploadToken ||
      !Number.isSafeInteger(result.expiresAtMs) ||
      !Number.isSafeInteger(result.maxBytes) ||
      result.maxBytes < input.image.bytes.byteLength
    )
      throw new Error(
        "The logo preparation receipt is invalid. No badge was changed.",
      );
    return result;
  }
  async upload(
    prepared: PreparedLogoUpload,
    image: LocalUploadImage,
    requestId: string,
  ) {
    assertOriginalImage(image);
    const result = await this.request<{
      uploadId: string;
      status: "uploaded";
      byteSize: number;
    }>(
      `uploads/${encodeURIComponent(prepared.uploadId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": image.mimeType,
          "Idempotency-Key": `${requestId}-upload`,
          "X-Media-Upload-Token": prepared.uploadToken,
        },
        body: Uint8Array.from(image.bytes).buffer,
      },
      60_000,
    );
    if (
      result.uploadId !== prepared.uploadId ||
      result.status !== "uploaded" ||
      result.byteSize !== image.bytes.byteLength
    )
      throw new Error(
        "The upload acknowledgement differs from the captured logo bytes.",
      );
    return result;
  }
  async complete(prepared: PreparedLogoUpload, requestId: string) {
    const result = await this.request<ProcessedLogoUpload>(
      `uploads/${encodeURIComponent(prepared.uploadId)}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `${requestId}-complete`,
          "X-Media-Upload-Token": prepared.uploadToken,
        },
        body: "{}",
      },
      45_000,
    );
    this.assertAsset(result.asset, prepared.asset.kind, prepared.asset.clubId);
    if (
      result.kind !== "processed-logo-upload" ||
      result.status !== "processed" ||
      result.uploadId !== prepared.uploadId ||
      logoReferenceKey(result.asset) !== logoReferenceKey(prepared.asset) ||
      !Number.isSafeInteger(result.width) ||
      result.width < 1 ||
      !Number.isSafeInteger(result.height) ||
      result.height < 1
    )
      throw new Error(
        "The logo processing receipt differs from the original upload. No badge was changed.",
      );
    return result;
  }
  private assertAsset(
    asset: LogoReference,
    kind: BrandKind,
    clubId: string | null = null,
  ) {
    if (
      !asset ||
      !["club_logo", "team_logo"].includes(kind) ||
      !identifier(asset.assetId) ||
      !Number.isSafeInteger(asset.revision) ||
      asset.revision < 1 ||
      asset.kind !== kind ||
      !identifier(asset.clubId) ||
      (this.scope.clubId !== undefined && asset.clubId !== this.scope.clubId) ||
      (clubId && asset.clubId !== clubId) ||
      (kind === "club_logo"
        ? asset.teamId !== null
        : asset.teamId !== this.scope.teamId)
    )
      throw new Error(
        "The logo reference differs from this authorised kind and owner.",
      );
  }
  async image(
    asset: LogoReference,
    mode: "own" | "published",
    variant: "thumbnail" | "display" = "display",
  ): Promise<Uint8Array> {
    this.assertAsset(asset, asset.kind);
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await this.authenticatedFetch(
        this.url(
          `assets/${encodeURIComponent(asset.assetId)}/revisions/${asset.revision}/${variant}`,
          `&mode=${mode}`,
        ),
        {
          signal: abort.signal,
          redirect: "error",
          credentials: "omit",
          headers: this.headers({ Accept: "image/png" }),
        },
      );
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("image/png")
      )
        throw new Error(
          "The current logo derivative is unavailable to this account.",
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.byteLength < 8 ||
        bytes.byteLength > 8 * 1024 * 1024 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every(
          (byte, index) => bytes[index] === byte,
        )
      )
        throw new Error(
          "The logo service returned an invalid or oversized PNG derivative.",
        );
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }
}
// Publishing is deliberately routed through the existing protected Workspace mutation outbox.
export type LogoPublicationCommand = BrandingCommand;

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
/** Refuse inconsistent ancestry/effective selection before a private DTO can attach to the current scope. */
export function assertBrandingResponse(
  value: unknown,
  scope: BrandClientScope,
): asserts value is BrandingDto {
  const fail = () => {
    throw new Error(
      "The branding response differs from this current authorised scope. Private logo data was discarded.",
    );
  };
  if (
    !object(value) ||
    value.kind !== "team-branding" ||
    value.teamId !== scope.teamId ||
    value.authoritySeasonId !== scope.authoritySeasonId ||
    !identifier(value.clubId) ||
    (scope.clubId !== undefined && value.clubId !== scope.clubId) ||
    !identifier(value.policyVersion) ||
    typeof value.canWriteClub !== "boolean" ||
    typeof value.canWriteTeam !== "boolean" ||
    !Array.isArray(value.assets) ||
    !object(value.club) ||
    !object(value.team) ||
    !object(value.effective)
  )
    return fail();
  if (
    value.club.id !== value.clubId ||
    value.team.id !== scope.teamId ||
    typeof value.club.name !== "string" ||
    typeof value.team.name !== "string" ||
    typeof value.team.ageGroup !== "string" ||
    ![value.club.slotVersion, value.team.slotVersion].every(
      (version) => Number.isSafeInteger(version) && Number(version) >= 0,
    )
  )
    return fail();
  const reference = (asset: unknown, expected?: BrandKind) => {
    if (
      !object(asset) ||
      !identifier(asset.assetId) ||
      !Number.isSafeInteger(asset.revision) ||
      Number(asset.revision) < 1 ||
      !["club_logo", "team_logo"].includes(String(asset.kind)) ||
      (expected && asset.kind !== expected) ||
      asset.clubId !== value.clubId ||
      asset.teamId !== (asset.kind === "club_logo" ? null : scope.teamId) ||
      "seasonId" in asset ||
      "matchId" in asset
    )
      return fail();
  };
  if (value.club.logo !== null) reference(value.club.logo, "club_logo");
  if (value.team.logo !== null) reference(value.team.logo, "team_logo");
  const expected = value.team.logo ?? value.club.logo,
    source = value.team.logo ? "team" : value.club.logo ? "club" : "neutral";
  if (
    value.effective.source !== source ||
    (expected == null
      ? value.effective.logo !== null
      : !object(value.effective.logo) ||
        logoReferenceKey(value.effective.logo as unknown as LogoReference) !==
          logoReferenceKey(expected as LogoReference))
  )
    return fail();
  const seen = new Set<string>();
  for (const asset of value.assets) {
    reference(asset);
    if (
      !object(asset) ||
      ![
        "prepared",
        "uploaded",
        "processing",
        "processed",
        "published",
        "rejected",
      ].includes(String(asset.status)) ||
      !Number.isSafeInteger(asset.byteSize) ||
      Number(asset.byteSize) < 1 ||
      !Number.isSafeInteger(asset.createdAt) ||
      Number(asset.createdAt) < 0 ||
      ![asset.width, asset.height, asset.processedAt].every(
        (item) =>
          item === null || (Number.isSafeInteger(item) && Number(item) >= 0),
      )
    )
      return fail();
    const key = logoReferenceKey(asset as unknown as LogoReference);
    if (seen.has(key)) return fail();
    seen.add(key);
  }
}

/** Used at the actual image attachment boundary; stale authority cannot return private bytes to a view. */
export async function readCurrentBrandImage(
  client: Pick<BrandMediaClient, "image">,
  reference: LogoReference,
  mode: "own" | "published",
  variant: "thumbnail" | "display",
  assertAccess: () => Promise<void>,
): Promise<Uint8Array> {
  await assertAccess();
  const bytes = await client.image(reference, mode, variant);
  await assertAccess();
  return bytes;
}
