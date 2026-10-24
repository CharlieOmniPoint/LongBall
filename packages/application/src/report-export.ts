export const REPORT_EXPORT_MAX_BYTES = 5 * 1024 * 1024;
export const REPORT_EXPORT_KINDS = ['own_participation', 'team_participation', 'attendance', 'match_summary', 'season_results'] as const;
export type ReportExportKind = typeof REPORT_EXPORT_KINDS[number];
export interface ReportExportRequest {
  kind: ReportExportKind;
  teamId: string;
  seasonId: string;
  matchId?: string | null;
  format: 'csv' | 'pdf';
}
export interface ReportExportStatus {
  id: string;
  status: 'queued' | 'working' | 'ready' | 'failed' | 'expired';
  downloadPath: string | null;
  expiresAt: string | null;
  failureCode: string | null;
  publicationPolicyVersions: { policyId: string; version: number }[];
  generatedAt: string | null;
}

export function parseReportExportRequest(value: unknown): ReportExportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a report, its team-season and CSV or PDF.');
  const request = value as Record<string, unknown>;
  const id = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 150 && !/[\u0000-\u001f\u007f]/.test(input);
  if (Object.keys(request).some(key => !['kind', 'teamId', 'seasonId', 'matchId', 'format'].includes(key)) || !REPORT_EXPORT_KINDS.includes(request.kind as ReportExportKind) || !id(request.teamId) || !id(request.seasonId) || typeof request.format !== 'string' || !['csv', 'pdf'].includes(request.format) || request.matchId !== undefined && request.matchId !== null && !id(request.matchId) || request.kind === 'match_summary' && !id(request.matchId) || request.kind !== 'match_summary' && request.matchId != null) throw new Error('Use the exact report kind, team-season, optional match and supported format.');
  return { kind: request.kind as ReportExportKind, teamId: request.teamId, seasonId: request.seasonId, matchId: request.matchId as string | null | undefined ?? null, format: request.format as 'csv' | 'pdf' };
}
