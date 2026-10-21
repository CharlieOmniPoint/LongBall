import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { AccessError } from "../../../packages/application/src/access";
import {
  authorizeCommunityMedia,
  type CommunityActor,
  type CommunityCommand,
  type CommunityState,
} from "../../../packages/application/src/community";
import {
  MEDIA_LIMITS,
  mediaInternals,
  type UploadRow,
  type MediaScanner,
  type MediaPrepareInput,
  type PreparedMediaUpload,
} from "./media";
import { installMediaSecurity, verifyMediaSecurity } from './postgres-security';
import type { PgDatabase } from "./pg";

const {
  executeFile,
  hash,
  id,
  auth,
  sameToken,
  bounded,
  actualMime,
  rejectAnimatedPng,
} = mediaInternals;
function fail(code: string, status: number, message: string): never {
  return mediaInternals.fail(code, status, message);
}

/** Real asynchronous PostgreSQL manifests; the private bounded byte pipeline is shared. */
export class PgMediaService {
  readonly directory: string;
  readonly database: PgDatabase;
  readonly scanner?: MediaScanner;
  readonly now: () => number;
  constructor(options: {
    directory: string;
    database: PgDatabase;
    scanner?: MediaScanner;
    now?: () => number;
  }) {
    this.directory = resolve(options.directory);
    this.database = options.database;
    this.scanner = options.scanner;
    this.now = options.now ?? Date.now;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    for (const name of ["quarantine", "derivatives"]) {
      mkdirSync(join(this.directory, name), { recursive: true, mode: 0o700 });
      chmodSync(join(this.directory, name), 0o700);
    }
  }
  static async open(
    options: ConstructorParameters<typeof PgMediaService>[0],
  ): Promise<PgMediaService> {
    const service = new PgMediaService(options);
    await service.initialize();
    return service;
  }
  async initialize(): Promise<void> {
    if (this.database.migrationMode === 'verify') {
      const versions = await this.database.query<{ version: number }>(
        'SELECT version FROM longball.media_schema_migrations ORDER BY version',
      );
      if (versions.rows.some(row => row.version > 2)) throw new Error('Media schema is newer than this build.');
      if (!versions.rows.some(row => row.version === 2)) throw new Error('Run the separate media migrator before starting the runtime.');
      await verifyMediaSecurity(this.database);
      return;
    }
    await this.database.transaction(async () => {
      await this.database.query(
        "CREATE TABLE IF NOT EXISTS longball.media_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const versions = await this.database.query<{ version: number }>(
        "SELECT version FROM longball.media_schema_migrations ORDER BY version",
      );
      if (versions.rows.some((row) => row.version > 2))
        throw new Error(
          "Media schema is newer than this build; preserve it and use a compatible version.",
        );
      if (!versions.rows.some((row) => row.version === 1)) {
        await this.database.query(`CREATE TABLE longball.media_uploads(
          id text PRIMARY KEY,request_id text NOT NULL,request_signature text NOT NULL,owner_id text NOT NULL REFERENCES longball.accounts(id),team_id text NOT NULL REFERENCES longball.teams(id),season_id text NOT NULL,match_id text NOT NULL,
          photo_id text NOT NULL,source_revision integer,display_revision integer NOT NULL CHECK(display_revision>0),status text NOT NULL CHECK(status IN('prepared','uploading','uploaded','processing','processed','linked','rejected')),
          expected_bytes integer NOT NULL CHECK(expected_bytes BETWEEN 1 AND 15728640),expected_sha text NOT NULL CHECK(expected_sha ~ '^[0-9a-f]{64}$'),declared_mime text NOT NULL CHECK(declared_mime IN('image/jpeg','image/png')),
          caption text NOT NULL,token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),expires_at bigint NOT NULL,created_at bigint NOT NULL,
          original_key text,display_key text,thumbnail_key text,width integer,height integer,scanner_engine text,failure_code text,attempt text,lease_until bigint,
          UNIQUE(owner_id,request_id));
          CREATE UNIQUE INDEX media_linked_revision ON longball.media_uploads(photo_id,display_revision) WHERE status='linked';
          CREATE INDEX media_owner_scope ON longball.media_uploads(owner_id,team_id,season_id,created_at);
          INSERT INTO longball.media_schema_migrations(version) VALUES(1);`);
      }
      if (!versions.rows.some(row => row.version === 2)) {
        await installMediaSecurity(this.database);
        await this.database.query('INSERT INTO longball.media_schema_migrations(version) VALUES(2)');
      }
    });
  }
  /** Injected connection lifecycle belongs to the API/store. */
  async close(): Promise<void> {}
  private async one(
    sql: string,
    values: readonly unknown[],
  ): Promise<UploadRow | undefined> {
    return (await this.database.query(sql, values)).rows[0] as
      | UploadRow
      | undefined;
  }
  private async many(
    sql: string,
    values: readonly unknown[],
  ): Promise<UploadRow[]> {
    return (await this.database.query(sql, values)).rows as UploadRow[];
  }
  private async execute(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ changes: number }> {
    return { changes: (await this.database.query(sql, values)).rowCount ?? 0 };
  }
  private path(key: string): string {
    const path = resolve(this.directory, key);
    if (!path.startsWith(this.directory + sep))
      fail(
        "MEDIA_STORE_INVALID",
        503,
        "The private media object is unavailable.",
      );
    return path;
  }

  private async row(
    state: CommunityState,
    actor: CommunityActor,
    uploadId: string,
    token?: string,
  ): Promise<UploadRow> {
    auth(state, actor, this.now(), true);
    if (!id(uploadId))
      fail("NOT_FOUND", 404, "The requested upload is unavailable.");
    const row = (await this.one(
      "SELECT * FROM longball.media_uploads WHERE id=$1 AND owner_id=$2 AND team_id=$3 AND season_id=$4",
      [uploadId, actor.accountId, actor.teamId, actor.seasonId],
    )) as UploadRow | undefined;
    if (!row || (token !== undefined && !sameToken(row.token_hash, token)))
      fail("NOT_FOUND", 404, "The requested upload is unavailable.");
    return row;
  }

  async prepare(
    state: CommunityState,
    actor: CommunityActor,
    input: MediaPrepareInput,
  ): Promise<PreparedMediaUpload> {
    return this.database.transaction(async () => {
      auth(state, actor, this.now(), true);
      const allowedKeys = [
        "requestId",
        "matchId",
        "byteSize",
        "mimeType",
        "sha256",
        "caption",
        "policyAcknowledged",
        "photoId",
        "sourceRevision",
      ];
      if (
        !input ||
        typeof input !== "object" ||
        Object.keys(input).some((key) => !allowedKeys.includes(key)) ||
        !id(input.requestId) ||
        !id(input.matchId) ||
        !Number.isSafeInteger(input.byteSize) ||
        input.byteSize < 1 ||
        input.byteSize > MEDIA_LIMITS.maxBytes ||
        !["image/jpeg", "image/png"].includes(input.mimeType) ||
        typeof input.sha256 !== "string" ||
        !/^[a-fA-F0-9]{64}$/.test(input.sha256) ||
        typeof input.caption !== "string" ||
        input.caption.trim().length > 160 ||
        input.policyAcknowledged !== true
      ) {
        fail(
          "INVALID_MEDIA_PREPARATION",
          422,
          "Use a JPEG or PNG up to 15 MiB with a valid size, SHA-256 and policy acknowledgement. HEIC is not enabled until its decoder is validated.",
        );
      }
      const match = state.matches.find(
        (item) =>
          item.id === input.matchId &&
          item.teamId === actor.teamId &&
          item.seasonId === actor.seasonId,
      );
      if (!match) fail("NOT_FOUND", 404, "The requested match is unavailable.");
      const signature = hash(
        JSON.stringify([
          input.matchId,
          input.byteSize,
          input.mimeType,
          input.sha256.toLowerCase(),
          input.caption.trim(),
          input.policyAcknowledged,
          input.photoId ?? null,
          input.sourceRevision ?? null,
        ]),
      );
      const existing = (await this.one(
        "SELECT * FROM longball.media_uploads WHERE owner_id=$1 AND request_id=$2",
        [actor.accountId, input.requestId],
      )) as UploadRow | undefined;
      const token = randomBytes(32).toString("base64url");
      if (existing) {
        if (
          existing.request_signature !== signature ||
          existing.team_id !== actor.teamId ||
          existing.season_id !== actor.seasonId
        )
          fail(
            "IDEMPOTENCY_CONFLICT",
            409,
            "This upload request identity was already used for different content.",
          );
        if (
          existing.expires_at <= this.now() &&
          ["prepared", "uploading"].includes(existing.status)
        )
          fail(
            "UPLOAD_EXPIRED",
            410,
            "The upload window expired. Prepare a new upload without discarding the previous private record.",
          );
        await this.execute(
          "UPDATE longball.media_uploads SET token_hash=$1 WHERE id=$2",
          [hash(token), existing.id],
        );
        return {
          uploadId: existing.id,
          photoId: existing.photo_id,
          uploadToken: token,
          expiresAtMs: existing.expires_at,
          maxBytes: MEDIA_LIMITS.maxBytes,
          displayRevision: existing.display_revision,
        };
      }
      let sourceRevision: number | null = null;
      let photoId = `media-${randomUUID()}`;
      if (input.photoId !== undefined || input.sourceRevision !== undefined) {
        const photo = state.photos.find(
          (item) =>
            item.id === input.photoId &&
            item.matchId === match.id &&
            item.teamId === actor.teamId &&
            item.seasonId === actor.seasonId &&
            item.uploaderAccountId === actor.accountId &&
            item.uploaderRole === actor.role &&
            item.removedAtMs === null,
        );
        if (
          !photo ||
          !Number.isSafeInteger(input.sourceRevision) ||
          photo.currentRevision !== input.sourceRevision
        )
          fail(
            "MEDIA_REVISION_CONFLICT",
            409,
            "The photo changed. Review its current revision before replacing it.",
          );
        sourceRevision = photo.currentRevision;
        photoId = photo.id;
      }
      const uploadId = randomUUID();
      const expiresAtMs = this.now() + MEDIA_LIMITS.uploadWindowMs;
      await this.execute(
        "INSERT INTO longball.media_uploads(id,request_id,request_signature,owner_id,team_id,season_id,match_id,photo_id,source_revision,display_revision,status,expected_bytes,expected_sha,declared_mime,caption,token_hash,expires_at,created_at)\n      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$12,$13,$14,$15,$16,$17)",
        [
          uploadId,
          input.requestId,
          signature,
          actor.accountId,
          actor.teamId,
          actor.seasonId,
          match.id,
          photoId,
          sourceRevision,
          (sourceRevision ?? 0) + 1,
          input.byteSize,
          input.sha256.toLowerCase(),
          input.mimeType,
          input.caption.trim(),
          hash(token),
          expiresAtMs,
          this.now(),
        ],
      );
      return {
        uploadId,
        photoId,
        uploadToken: token,
        expiresAtMs,
        maxBytes: MEDIA_LIMITS.maxBytes,
        displayRevision: (sourceRevision ?? 0) + 1,
      };
    });
  }

  async upload(
    state: CommunityState,
    actor: CommunityActor,
    uploadId: string,
    token: string,
    source: AsyncIterable<Uint8Array>,
  ) {
    const row = await this.row(state, actor, uploadId, token);
    const duplicate = ["uploaded", "processed", "linked"].includes(row.status);
    if (!duplicate && row.expires_at <= this.now())
      fail("UPLOAD_EXPIRED", 410, "The write-only upload window expired.");
    if (
      !duplicate &&
      row.status !== "prepared" &&
      !(row.status === "uploading" && (row.lease_until ?? 0) < this.now())
    )
      fail(
        "UPLOAD_BUSY",
        409,
        "This upload is already running or cannot be changed.",
      );
    const attempt = randomUUID();
    const key = `quarantine/${row.id}-${attempt}.upload`;
    const temporary = this.path(key + ".part");
    if (!duplicate) {
      const updated = await this.execute(
        "UPDATE longball.media_uploads SET status='uploading',attempt=$1,lease_until=$2,failure_code=NULL WHERE id=$3 AND (status='prepared' OR (status='uploading' AND lease_until<$4))",
        [attempt, this.now() + 65_000, row.id, this.now()],
      );
      if (!updated.changes)
        fail("UPLOAD_BUSY", 409, "This upload is already running.");
    }
    const destination = duplicate ? null : await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    let received = 0;
    const began = performance.now();
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await bounded(
          iterator.next(),
          MEDIA_LIMITS.uploadTimeoutMs - (performance.now() - began),
          "UPLOAD_TIMEOUT",
        );
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        received += chunk.length;
        if (received > row.expected_bytes || received > MEDIA_LIMITS.maxBytes)
          fail(
            "UPLOAD_TOO_LARGE",
            413,
            "The image exceeds its declared upload size.",
          );
        digest.update(chunk);
        if (destination) await destination.writeFile(chunk);
      }
      if (
        received !== row.expected_bytes ||
        digest.digest("hex") !== row.expected_sha
      )
        fail(
          "UPLOAD_INTEGRITY_FAILED",
          422,
          "The uploaded size or SHA-256 does not match. The private partial upload was not accepted.",
        );
      if (destination) {
        await destination.sync();
        await destination.close();
        await rename(temporary, this.path(key));
        const changed = await this.execute(
          "UPDATE longball.media_uploads SET status='uploaded',original_key=$1,lease_until=NULL,failure_code=NULL WHERE id=$2 AND attempt=$3 AND status='uploading'",
          [key, row.id, attempt],
        );
        if (!changed.changes)
          fail(
            "UPLOAD_LEASE_CHANGED",
            409,
            "The upload lease changed. The private branch is retained for review.",
          );
      }
      return { uploadId, status: "uploaded" as const, byteSize: received };
    } catch (error) {
      if (destination) {
        await destination.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
      if (!duplicate)
        await this.execute(
          "UPDATE longball.media_uploads SET status='prepared',failure_code='UPLOAD_INCOMPLETE',lease_until=NULL WHERE id=$1 AND attempt=$2 AND status='uploading'",
          [row.id, attempt],
        );
      if (iterator.return)
        void Promise.resolve(iterator.return()).catch(() => undefined);
      throw error;
    }
  }

  private completion(row: UploadRow) {
    const base = {
      id: `media-${row.id}-completed`,
      photoId: row.photo_id,
      art: "pitch" as const,
      caption: row.caption,
      policyAcknowledged: true as const,
    };
    const command: CommunityCommand =
      row.source_revision === null
        ? { ...base, type: "photo.submitted", matchId: row.match_id }
        : {
            ...base,
            type: "photo.revised",
            sourceRevision: row.source_revision,
          };
    return {
      command,
      receipt: {
        uploadId: row.id,
        photoId: row.photo_id,
        status: "processed" as const,
        width: row.width!,
        height: row.height!,
        displayRevision: row.display_revision,
      },
    };
  }

  async complete(
    state: CommunityState,
    actor: CommunityActor,
    uploadId: string,
    token: string,
  ) {
    const row = await this.row(state, actor, uploadId, token);
    if (row.status === "processed" || row.status === "linked")
      return this.completion(row);
    if (
      row.status !== "uploaded" &&
      !(row.status === "processing" && (row.lease_until ?? 0) < this.now())
    )
      fail(
        "UPLOAD_NOT_READY",
        409,
        "Finish the private upload before completion; an active processing lease cannot be duplicated.",
      );
    if (!row.original_key)
      fail("UPLOAD_NOT_READY", 409, "The private original is unavailable.");
    const attempt = randomUUID();
    const leased = await this.execute(
      "UPDATE longball.media_uploads SET status='processing',attempt=$1,lease_until=$2,failure_code=NULL WHERE id=$3 AND (status='uploaded' OR (status='processing' AND lease_until<$4))",
      [attempt, this.now() + 60_000, row.id, this.now()],
    );
    if (!leased.changes)
      fail("UPLOAD_BUSY", 409, "This image is already processing.");
    try {
      const original = await readFile(this.path(row.original_key));
      if (
        original.length !== row.expected_bytes ||
        hash(original) !== row.expected_sha
      )
        fail(
          "UPLOAD_INTEGRITY_FAILED",
          422,
          "The private original does not match its recorded size and hash.",
        );
      const mimeType = actualMime(original);
      if (!mimeType || mimeType !== row.declared_mime)
        fail(
          "MEDIA_TYPE_MISMATCH",
          415,
          "Decoded image type must match its bytes. Only JPEG and PNG are enabled.",
        );
      rejectAnimatedPng(original);
      if (!this.scanner)
        fail(
          "SCANNER_REQUIRED",
          503,
          "Image safety scanning is not configured. The original remains private; no reviewable or published image was created.",
        );
      const scan = await bounded(
        this.scanner.scan(original, { mimeType, sha256: row.expected_sha }),
        MEDIA_LIMITS.scannerTimeoutMs,
        "SCANNER_UNAVAILABLE",
      );
      if (scan.verdict === "unavailable")
        fail(
          "SCANNER_UNAVAILABLE",
          503,
          "Image scanning is unavailable. The original remains private for a safe retry.",
        );
      if (scan.verdict !== "clean")
        fail(
          "IMAGE_SCAN_REJECTED",
          422,
          "The image did not pass safety scanning and remains unpublished.",
        );
      const displayKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-display.jpg`;
      const thumbnailKey = `derivatives/${row.photo_id}-v${row.display_revision}-${attempt}-thumbnail.jpg`;
      let decoded: { width: number; height: number };
      try {
        const result = await executeFile(
          process.execPath,
          [
            "--max-old-space-size=128",
            fileURLToPath(new URL("./media-worker.mjs", import.meta.url)),
            this.path(row.original_key),
            this.path(displayKey),
            this.path(thumbnailKey),
            mimeType,
          ],
          {
            timeout: MEDIA_LIMITS.decodeTimeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
        );
        decoded = JSON.parse(result.stdout) as {
          width: number;
          height: number;
        };
        if (
          !Number.isSafeInteger(decoded.width) ||
          !Number.isSafeInteger(decoded.height) ||
          decoded.width < 1 ||
          decoded.height < 1 ||
          decoded.width > MEDIA_LIMITS.displayEdge ||
          decoded.height > MEDIA_LIMITS.displayEdge
        )
          throw new Error();
      } catch {
        fail(
          "IMAGE_DECODE_REJECTED",
          415,
          "The image could not be safely decoded within the supported format, pixel and processing limits.",
        );
      }
      const saved = await this.execute(
        "UPDATE longball.media_uploads SET status='processed',display_key=$1,thumbnail_key=$2,width=$3,height=$4,scanner_engine=$5,failure_code=NULL,lease_until=NULL WHERE id=$6 AND attempt=$7 AND status='processing'",
        [
          displayKey,
          thumbnailKey,
          decoded.width,
          decoded.height,
          scan.engine.slice(0, 100),
          row.id,
          attempt,
        ],
      );
      if (!saved.changes)
        fail(
          "PROCESSING_LEASE_CHANGED",
          409,
          "The processing lease changed. No publication was performed.",
        );
      return this.completion(await this.row(state, actor, uploadId));
    } catch (error) {
      const code =
        error instanceof AccessError ? error.code : "MEDIA_PROCESSING_FAILED";
      const retryable = [
        "SCANNER_REQUIRED",
        "SCANNER_UNAVAILABLE",
        "MEDIA_PROCESSING_FAILED",
      ].includes(code);
      await this.execute(
        "UPDATE longball.media_uploads SET status=$1,failure_code=$2,lease_until=NULL WHERE id=$3 AND attempt=$4 AND status='processing'",
        [retryable ? "uploaded" : "rejected", code, row.id, attempt],
      );
      throw error instanceof AccessError
        ? error
        : new AccessError(
            "MEDIA_PROCESSING_FAILED",
            503,
            "Image processing is unavailable. No image was published.",
          );
    }
  }

  async link(uploadId: string, state?: CommunityState): Promise<void> {
    const row = (await this.one(
      "SELECT * FROM longball.media_uploads WHERE id=$1",
      [uploadId],
    )) as UploadRow | undefined;
    if (!row || !["processed", "linked"].includes(row.status))
      fail(
        "MEDIA_NOT_PROCESSED",
        409,
        "The image has not completed private processing.",
      );
    if (
      state &&
      !state.photos.some(
        (photo) =>
          photo.id === row.photo_id &&
          photo.teamId === row.team_id &&
          photo.seasonId === row.season_id &&
          photo.uploaderAccountId === row.owner_id &&
          photo.revisions.some(
            (revision) => revision.version === row.display_revision,
          ),
      )
    )
      fail(
        "MEDIA_LINK_CONFLICT",
        409,
        "The matching community revision was not committed.",
      );
    await this.execute(
      "UPDATE longball.media_uploads SET status='linked' WHERE id=$1",
      [uploadId],
    );
  }

  async gateway(
    state: CommunityState,
    actor: CommunityActor,
    photoId: string,
    variant: "display" | "thumbnail",
    mode: "gallery" | "own" | "review" = "gallery",
    revision?: number,
  ) {
    if (!["display", "thumbnail"].includes(variant))
      fail("NOT_FOUND", 404, "The media variant is unavailable.");
    const decision = authorizeCommunityMedia(
      state,
      actor,
      photoId,
      this.now(),
      mode,
      revision,
    );
    if (!decision.allowed)
      fail("NOT_FOUND", 404, "The requested image is unavailable.");
    const row = (await this.one(
      "SELECT * FROM longball.media_uploads WHERE photo_id=$1 AND display_revision=$2 AND status='linked'",
      [photoId, decision.revision.version],
    )) as UploadRow | undefined;
    if (
      !row ||
      row.team_id !== actor.teamId ||
      row.season_id !== actor.seasonId
    )
      fail("NOT_FOUND", 404, "The requested image is unavailable.");
    const key = variant === "display" ? row.display_key : row.thumbnail_key;
    if (!key) fail("NOT_FOUND", 404, "The requested image is unavailable.");
    let body: Buffer;
    try {
      body = readFileSync(this.path(key));
    } catch {
      fail("NOT_FOUND", 404, "The requested image is unavailable.");
    }
    return {
      body,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(body.length),
      },
    };
  }

  async listOwn(state: CommunityState, actor: CommunityActor) {
    auth(state, actor, this.now(), true);
    const rows = (await this.many(
      "SELECT id,photo_id,status,expected_bytes,display_revision,width,height,failure_code,expires_at FROM longball.media_uploads WHERE owner_id=$1 AND team_id=$2 AND season_id=$3 ORDER BY created_at DESC LIMIT 100",
      [actor.accountId, actor.teamId, actor.seasonId],
    )) as unknown as Pick<
      UploadRow,
      | "id"
      | "photo_id"
      | "status"
      | "expected_bytes"
      | "display_revision"
      | "width"
      | "height"
      | "failure_code"
      | "expires_at"
    >[];
    return rows.map((row) => ({
      uploadId: row.id,
      photoId: row.photo_id,
      status: row.status,
      byteSize: row.expected_bytes,
      displayRevision: row.display_revision,
      width: row.width,
      height: row.height,
      failureCode: row.failure_code,
      expiresAtMs: row.expires_at,
    }));
  }
}
