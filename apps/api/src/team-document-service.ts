import { createHash } from "node:crypto";
import {
  PDFDocument,
  PDFDict,
  PDFArray,
  PDFName,
  PDFStream,
  type PDFObject,
} from "pdf-lib";
import {
  AccessError,
  assertAdultAuthority,
  assertTeamRole,
  type Principal,
} from "../../../packages/application/src/access";
import type {
  TeamDocumentCommand,
  TeamDocumentView,
  TeamDocumentDownload,
} from "../../../packages/application/src/team-documents";
import { DevelopmentStore } from "./store";
import { PostgresStore } from "./postgres-store";
import type { RuntimeStore } from "./runtime-store";

export interface TeamDocumentSession {
  principal: Principal;
  teamId: string;
  seasonId: string;
  role?: string;
}
interface Row {
  club_id: string;
  team_id: string;
  revision: number;
  file_name: string | null;
  pdf_base64: string | null;
  sha256: string | null;
  byte_length: number;
  updated_at: number;
}
const denied = () =>
  new AccessError("NOT_FOUND", 404, "The requested team sheet is unavailable.");
export const MAX_TEAM_SHEET_BYTES = 5 * 1024 * 1024;
function activePdfObject(object: PDFObject): boolean {
  const forbidden = new Set([
    "JavaScript",
    "JS",
    "Launch",
    "EmbeddedFile",
    "OpenAction",
    "AA",
    "XFA",
  ]);
  if (object instanceof PDFName) return forbidden.has(object.decodeText());
  if (object instanceof PDFDict)
    return object
      .entries()
      .some(
        ([key, value]) =>
          forbidden.has(key.decodeText()) || activePdfObject(value),
      );
  if (object instanceof PDFArray) return object.asArray().some(activePdfObject);
  if (object instanceof PDFStream) return activePdfObject(object.dict);
  return false;
}
export async function validateTeamSheetPdf(
  base64: unknown,
): Promise<{ bytes: Buffer; hash: string }> {
  if (
    typeof base64 !== "string" ||
    base64.length > Math.ceil(MAX_TEAM_SHEET_BYTES / 3) * 4 ||
    !base64.length ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    throw new AccessError(
      "INVALID_PDF",
      422,
      "Choose a PDF team sheet of at most 5 MB.",
    );
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length > MAX_TEAM_SHEET_BYTES ||
    bytes.length < 8 ||
    bytes.toString("ascii", 0, 5) !== "%PDF-" ||
    bytes.toString("base64") !== base64
  )
    throw new AccessError(
      "INVALID_PDF",
      422,
      "Choose a genuine PDF team sheet of at most 5 MB.",
    );
  try {
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 50)
      throw new Error("pages");
    for (const [, object] of pdf.context.enumerateIndirectObjects())
      if (activePdfObject(object)) throw new Error("active content");
  } catch {
    throw new AccessError(
      "INVALID_PDF",
      422,
      "Use an unencrypted PDF with one to 50 pages and no scripts, attachments or launch actions.",
    );
  }
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}
export class TeamDocumentService {
  constructor(
    private readonly source: DevelopmentStore | PostgresStore,
    private readonly runtime: RuntimeStore,
  ) {}
  async initialize(): Promise<void> {
    if (this.source instanceof DevelopmentStore)
      this.source.database.exec(
        `CREATE TABLE IF NOT EXISTS team_documents(club_id TEXT NOT NULL,team_id TEXT PRIMARY KEY REFERENCES teams(id),revision INTEGER NOT NULL CHECK(revision>0),file_name TEXT,pdf_base64 TEXT,sha256 TEXT,byte_length INTEGER NOT NULL,updated_at INTEGER NOT NULL);`,
      );
  }
  private async actor(session: TeamDocumentSession): Promise<Principal> {
    if (session.role !== "manager" && session.role !== "administrator")
      throw denied();
    const p = await this.runtime.principal({
      issuer: session.principal.issuer,
      subject: session.principal.subject,
      strongAuth: session.principal.strongAuth,
      authenticatedAt: session.principal.authenticatedAt,
    });
    if (p.accountId !== session.principal.accountId) throw denied();
    assertAdultAuthority(p, false, this.runtime.now());
    assertTeamRole(
      p,
      await this.runtime.memberships(),
      session.teamId,
      session.seasonId,
      [session.role],
      this.runtime.now(),
    );
    return p;
  }
  private async row(teamId: string): Promise<Row | null> {
    if (this.source instanceof PostgresStore)
      return (await this.source.one(
        "SELECT * FROM team_documents WHERE team_id=$1",
        [teamId],
      )) as unknown as Row | null;
    return (
      (this.source.database
        .prepare("SELECT * FROM team_documents WHERE team_id=?")
        .get(teamId) as unknown as Row) ?? null
    );
  }
  private dto(teamId: string, row: Row | null): TeamDocumentView {
    return {
      kind: "team-document",
      teamId,
      revision: row?.revision ?? 0,
      document: row?.pdf_base64
        ? {
            fileName: row.file_name!,
            byteLength: row.byte_length,
            sha256: row.sha256!,
            updatedAtMs: row.updated_at,
          }
        : null,
    };
  }
  async view(session: TeamDocumentSession): Promise<TeamDocumentView> {
    await this.actor(session);
    return this.dto(session.teamId, await this.row(session.teamId));
  }
  async download(session: TeamDocumentSession): Promise<TeamDocumentDownload> {
    await this.actor(session);
    const row = await this.row(session.teamId);
    if (!row?.pdf_base64) throw denied();
    return { ...this.dto(session.teamId, row), base64: row.pdf_base64 };
  }
  async command(
    session: TeamDocumentSession,
    raw: unknown,
  ): Promise<TeamDocumentView> {
    const principal = await this.actor(session);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Use the team sheet command.",
      );
    const command = raw as TeamDocumentCommand;
    if (
      !/^[A-Za-z0-9_-]{8,150}$/.test(command.id) ||
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 0 ||
      !["team_sheet.uploaded", "team_sheet.removed"].includes(command.type) ||
      Object.keys(command).some(
        (k) =>
          !(
            command.type === "team_sheet.uploaded"
              ? ["id", "type", "expectedRevision", "fileName", "base64"]
              : ["id", "type", "expectedRevision"]
          ).includes(k),
      )
    )
      throw new AccessError(
        "INVALID_REQUEST",
        400,
        "Use the documented team sheet fields and source revision.",
      );
    let pdf: { bytes: Buffer; hash: string } | null = null;
    if (command.type === "team_sheet.uploaded") {
      if (
        typeof command.fileName !== "string" ||
        !/^.{1,116}\.pdf$/i.test(command.fileName) ||
        /[\u0000-\u001f\\/]/.test(command.fileName)
      )
        throw new AccessError(
          "INVALID_REQUEST",
          400,
          "Use a PDF filename of at most 120 characters.",
        );
      pdf = await validateTeamSheetPdf(command.base64);
    }
    return this.runtime.transaction(async () => {
      const previous = await this.row(session.teamId);
      if ((previous?.revision ?? 0) !== command.expectedRevision)
        throw new AccessError(
          "TEAM_DOCUMENT_CONFLICT",
          409,
          "The team sheet changed. Refresh before saving.",
        );
      const team =
        this.source instanceof PostgresStore
          ? await this.source.one("SELECT club_id FROM teams WHERE id=$1", [
              session.teamId,
            ])
          : this.source.database
              .prepare(
                "SELECT json_extract(value_json,'$.club.id') AS club_id FROM documents WHERE team_id=? AND season_id=? AND kind='preparation'",
              )
              .get(session.teamId, session.seasonId);
      if (!team?.club_id) throw denied();
      const row: Row = {
        club_id: String(team.club_id),
        team_id: session.teamId,
        revision: (previous?.revision ?? 0) + 1,
        file_name:
          command.type === "team_sheet.uploaded" ? command.fileName : null,
        pdf_base64:
          command.type === "team_sheet.uploaded" ? command.base64 : null,
        sha256: pdf?.hash ?? null,
        byte_length: pdf?.bytes.length ?? 0,
        updated_at: this.runtime.now(),
      };
      if (this.source instanceof PostgresStore)
        await this.source.execute(
          "INSERT INTO team_documents(club_id,team_id,revision,file_name,pdf_base64,sha256,byte_length,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(team_id) DO UPDATE SET revision=EXCLUDED.revision,file_name=EXCLUDED.file_name,pdf_base64=EXCLUDED.pdf_base64,sha256=EXCLUDED.sha256,byte_length=EXCLUDED.byte_length,updated_at=EXCLUDED.updated_at",
          Object.values(row),
        );
      else
        this.source.database
          .prepare(
            "INSERT INTO team_documents(club_id,team_id,revision,file_name,pdf_base64,sha256,byte_length,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(team_id) DO UPDATE SET revision=excluded.revision,file_name=excluded.file_name,pdf_base64=excluded.pdf_base64,sha256=excluded.sha256,byte_length=excluded.byte_length,updated_at=excluded.updated_at",
          )
          .run(...Object.values(row));
      await this.runtime.audit(
        principal,
        command.type,
        session.teamId,
        "accepted",
      );
      return this.dto(session.teamId, row);
    });
  }
}
