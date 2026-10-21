import { AccessError, assertAdultAuthority, assertTeamRole, type Membership, type Principal, type Role } from './access';

export const BRAND_POLICY_VERSION = 'logo-rights-v1';
export type BrandKind = 'club_logo' | 'team_logo';
export interface BrandReference { assetId: string; revision: number; kind: BrandKind; clubId: string; teamId: string | null }
export type LogoReference = BrandReference;
export type BrandAssetStatus = 'prepared' | 'uploaded' | 'processing' | 'processed' | 'published' | 'rejected';
/** Server-owned processing evidence, never accepted from an upload/publication body. */
export interface BrandAssetRecord extends BrandReference {
  ownerId: string; status: BrandAssetStatus; byteSize: number; width: number | null; height: number | null;
  createdAt: number; processedAt: number | null; scannerClean: boolean;
}
export interface BrandAssetView extends BrandReference {
  status: BrandAssetStatus; byteSize: number; width: number | null; height: number | null; createdAt: number; processedAt: number | null;
}
export interface BrandSlot {
  kind: BrandKind; clubId: string; teamId: string | null; version: number;
  assetId: string | null; assetRevision: number | null; reviewedRevision: number | null;
  policyVersion: string | null; confirmedBy: string | null; confirmedAt: number | null;
}
export interface BrandingContext {
  principal: Principal; memberships: Membership[]; selectedRole: Role; clubId: string; teamId: string; authoritySeasonId: string; nowMs: number;
  /** Fresh current grant evidence, independent of a retained spectator SQL row. */
  spectatorGrantActive?: boolean;
  policyVersion?: string;
}
export interface BrandingDto {
  kind: 'team-branding'; teamId: string; clubId: string; authoritySeasonId: string; policyVersion: string;
  club: { id: string; name: string; slotVersion: number; logo: BrandReference | null };
  team: { id: string; name: string; ageGroup: string; slotVersion: number; logo: BrandReference | null };
  effective: { source: 'team' | 'club' | 'neutral'; logo: BrandReference | null };
  canWriteClub: boolean; canWriteTeam: boolean; assets: BrandAssetView[];
}
export type BrandingCommand = { id: string; kind: BrandKind; expectedSlotVersion: number } & (
  { type: 'logo.published'; assetId: string; reviewedRevision: number; confirmRightsToUse: true; policyVersion: string }
  | { type: 'logo.removed' }
);
export type LogoPrepareInput = {
  byteSize: number; mimeType: 'image/jpeg' | 'image/png' | 'image/heic'; sha256: string; policyAcknowledged: true;
} & ({ kind: 'club_logo'; clubId: string } | { kind: 'team_logo'; teamId: string });

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 150 && !/[^A-Za-z0-9_-]/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new AccessError('INVALID_BRANDING', 422, message); }
function unavailable(): never { throw new AccessError('NOT_FOUND', 404, 'The requested branding is unavailable.'); }
function strict(value: Record<string, unknown>, keys: string[]) { requireThat(Object.keys(value).every(key => keys.includes(key)), 'Unexpected branding fields. Asset ancestry is assigned by the service.'); }
function kind(value: unknown): value is BrandKind { return value === 'club_logo' || value === 'team_logo'; }
function validateContext(context: BrandingContext): void {
  requireThat(id(context.clubId) && id(context.teamId) && id(context.authoritySeasonId) && integer(context.nowMs), 'Use the current verified branding scope.');
  assertTeamRole(context.principal, context.memberships, context.teamId, context.authoritySeasonId, [context.selectedRole], context.nowMs);
  if (context.selectedRole === 'administrator' || context.selectedRole === 'manager') assertAdultAuthority(context.principal, false, context.nowMs);
  if (context.selectedRole === 'spectator' && context.spectatorGrantActive !== true) unavailable();
}
export function brandScope(context: BrandingContext, assetKind: BrandKind): Pick<BrandReference, 'kind' | 'clubId' | 'teamId'> {
  requireThat(kind(assetKind), 'Choose a club or team logo.');
  return { kind: assetKind, clubId: context.clubId, teamId: assetKind === 'club_logo' ? null : context.teamId };
}
export function assertBrandAuthority(context: BrandingContext, assetKind: BrandKind): void {
  requireThat(kind(assetKind), 'Choose a club or team logo.');
  validateContext(context);
  if (assetKind === 'club_logo' ? context.selectedRole !== 'administrator' : context.selectedRole !== 'manager') unavailable();
  assertAdultAuthority(context.principal, false, context.nowMs);
}
function sameScope(context: BrandingContext, value: Pick<BrandReference, 'kind' | 'clubId' | 'teamId'>): boolean {
  return kind(value.kind) && value.clubId === context.clubId && value.teamId === (value.kind === 'club_logo' ? null : context.teamId);
}
export function emptyBrandSlot(context: BrandingContext, assetKind: BrandKind): BrandSlot {
  return { ...brandScope(context, assetKind), version: 0, assetId: null, assetRevision: null, reviewedRevision: null, policyVersion: null, confirmedBy: null, confirmedAt: null };
}
function reference(context: BrandingContext, slot: BrandSlot): BrandReference | null {
  requireThat(sameScope(context, slot) && integer(slot.version), 'The saved logo slot has inconsistent ancestry.');
  if (slot.assetId === null) { requireThat(slot.assetRevision === null && slot.reviewedRevision === null, 'An empty logo slot cannot retain an asset revision.'); return null; }
  requireThat(id(slot.assetId) && integer(slot.assetRevision) && slot.assetRevision > 0 && slot.reviewedRevision === slot.assetRevision && id(slot.confirmedBy) && integer(slot.confirmedAt) && id(slot.policyVersion), 'The published logo must match its reviewed revision and recorded publication.');
  return { assetId: slot.assetId, revision: slot.assetRevision, ...brandScope(context, slot.kind) };
}
export function resolveBranding(context: BrandingContext, club: BrandSlot, team: BrandSlot): BrandingDto['effective'] {
  requireThat(club.kind === 'club_logo' && team.kind === 'team_logo', 'Use separate club and team logo slots.');
  const clubLogo = reference(context, club), teamLogo = reference(context, team);
  return teamLogo ? { source: 'team', logo: teamLogo } : clubLogo ? { source: 'club', logo: clubLogo } : { source: 'neutral', logo: null };
}
export function brandingView(input: { context: BrandingContext; club: { id: string; name: string }; team: { id: string; name: string; ageGroup: string }; clubSlot: BrandSlot; teamSlot: BrandSlot; assets: BrandAssetRecord[] }): BrandingDto {
  const { context, club, team, clubSlot, teamSlot } = input;
  validateContext(context);
  requireThat(club.id === context.clubId && team.id === context.teamId, 'The branding labels belong to another scope.');
  const writable = (assetKind: BrandKind) => { try { assertBrandAuthority(context, assetKind); return true; } catch { return false; } };
  return { kind: 'team-branding', teamId: context.teamId, clubId: context.clubId, authoritySeasonId: context.authoritySeasonId, policyVersion: context.policyVersion ?? BRAND_POLICY_VERSION,
    club: { ...club, slotVersion: clubSlot.version, logo: reference(context, clubSlot) }, team: { ...team, slotVersion: teamSlot.version, logo: reference(context, teamSlot) }, effective: resolveBranding(context, clubSlot, teamSlot), canWriteClub: writable('club_logo'), canWriteTeam: writable('team_logo'),
    assets: input.assets.filter(asset => asset.ownerId === context.principal.accountId && sameScope(context, asset) && writable(asset.kind)).map(asset => ({ assetId: asset.assetId, revision: asset.revision, kind: asset.kind, clubId: asset.clubId, teamId: asset.teamId, status: asset.status, byteSize: asset.byteSize, width: asset.width, height: asset.height, createdAt: asset.createdAt, processedAt: asset.processedAt })),
  };
}
export function parseLogoPrepareInput(value: unknown): LogoPrepareInput {
  requireThat(object(value) && kind(value.kind), 'Choose an explicit club or team logo.');
  strict(value, ['kind', value.kind === 'club_logo' ? 'clubId' : 'teamId', 'byteSize', 'mimeType', 'sha256', 'policyAcknowledged']);
  requireThat(id(value.kind === 'club_logo' ? value.clubId : value.teamId), 'Use a valid logo-scope identifier.');
  requireThat(integer(value.byteSize) && value.byteSize > 0 && value.byteSize <= 15 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/heic'].includes(String(value.mimeType)) && typeof value.sha256 === 'string' && value.sha256.length === 64 && /^[a-fA-F0-9]{64}$/.test(value.sha256) && value.policyAcknowledged === true, 'Use a JPEG, PNG or HEIC up to 15 MiB with SHA-256 and explicit policy acknowledgement.');
  return { ...value, sha256: value.sha256.toLowerCase() } as LogoPrepareInput;
}
export function assertLogoPrepareScope(context: BrandingContext, input: LogoPrepareInput): ReturnType<typeof brandScope> {
  const parsed = parseLogoPrepareInput(input); assertBrandAuthority(context, parsed.kind);
  if (parsed.kind === 'club_logo' ? parsed.clubId !== context.clubId : parsed.teamId !== context.teamId) unavailable();
  return brandScope(context, parsed.kind);
}
export function parseBrandingCommand(value: unknown, expectedKind?: BrandKind): BrandingCommand {
  requireThat(object(value) && kind(value.kind) && (!expectedKind || expectedKind === value.kind), 'Use the requested logo kind.');
  requireThat(id(value.id) && integer(value.expectedSlotVersion), 'Use a stable command identity and current slot version.');
  if (value.type === 'logo.removed') strict(value, ['id', 'type', 'kind', 'expectedSlotVersion']);
  else {
    requireThat(value.type === 'logo.published', 'Use an explicit publish or remove command.');
    strict(value, ['id', 'type', 'kind', 'expectedSlotVersion', 'assetId', 'reviewedRevision', 'confirmRightsToUse', 'policyVersion']);
    requireThat(id(value.assetId) && integer(value.reviewedRevision) && value.reviewedRevision > 0 && value.confirmRightsToUse === true && id(value.policyVersion), 'Review the exact processed revision and confirm the rights policy before publishing.');
  }
  return { ...value } as BrandingCommand;
}
/** Pure transaction plan; the caller commits pointer, asset status, audit and receipt atomically. */
export function planBrandingCommand(context: BrandingContext, slot: BrandSlot, asset: BrandAssetRecord | null, input: BrandingCommand) {
  const command = parseBrandingCommand(input); assertBrandAuthority(context, command.kind);
  requireThat(slot.kind === command.kind, 'Choose the matching logo slot.');
  const before = reference(context, slot);
  if (slot.version !== command.expectedSlotVersion) throw new AccessError('STALE_REVISION', 409, 'The logo changed. Refresh and review before replacing it.');
  let after: BrandReference | null = null;
  if (command.type === 'logo.published') {
    if (!asset || asset.ownerId !== context.principal.accountId || !sameScope(context, asset) || asset.kind !== command.kind || asset.assetId !== command.assetId) unavailable();
    requireThat(asset.revision === command.reviewedRevision && ['processed', 'published'].includes(asset.status) && asset.scannerClean === true && integer(asset.processedAt) && integer(asset.width) && asset.width > 0 && integer(asset.height) && asset.height > 0, 'Publish only the exact clean, processed image revision you reviewed.');
    requireThat(command.policyVersion === (context.policyVersion ?? BRAND_POLICY_VERSION), 'Review the current logo rights policy before publishing.');
    after = { assetId: asset.assetId, revision: asset.revision, ...brandScope(context, command.kind) };
  }
  const updated: BrandSlot = { ...slot, version: slot.version + 1, assetId: after?.assetId ?? null, assetRevision: after?.revision ?? null, reviewedRevision: after?.revision ?? null, policyVersion: command.type === 'logo.published' ? command.policyVersion : null, confirmedBy: context.principal.accountId, confirmedAt: context.nowMs };
  return { slot: updated, asset: command.type === 'logo.published' ? { ...asset!, status: 'published' as const } : null, audit: { commandId: command.id, actorId: context.principal.accountId, action: command.type, kind: command.kind, clubId: context.clubId, teamId: command.kind === 'team_logo' ? context.teamId : null, before, after, at: context.nowMs } };
}
/** Recheck on every derivative fetch. No season, game or reusable read token is asset authority. */
export function authorizeBrandAsset(input: { context: BrandingContext; asset: BrandAssetRecord; slot: BrandSlot; revision: number; mode: 'own' | 'published' }): BrandReference {
  const { context, asset, slot, revision, mode } = input; validateContext(context);
  if (!sameScope(context, asset) || !integer(revision) || revision < 1 || asset.revision !== revision) unavailable();
  if (asset.scannerClean !== true || !['processed', 'published'].includes(asset.status)) unavailable();
  if (mode === 'own') {
    assertBrandAuthority(context, asset.kind);
    if (asset.ownerId !== context.principal.accountId) unavailable();
  } else if (mode === 'published') {
    const current = reference(context, slot);
    if (slot.kind !== asset.kind || asset.status !== 'published' || current?.assetId !== asset.assetId || current.revision !== revision) unavailable();
  } else unavailable();
  return { assetId: asset.assetId, revision: asset.revision, ...brandScope(context, asset.kind) };
}
