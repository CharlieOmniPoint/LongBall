import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { SQLITE_TEAM_PRIVILEGES_DDL } from './team-privilege-schema';
import { AccessError, assertAdultAuthority, assertCanAssignManager, assertCanManageTeam, assertTeamRole, currentMemberships, filterMatchForPrincipal, UNAPPROVED_SHARING_POLICY, type Membership, type Principal, type SharingPolicy } from '../../../packages/application/src/access';
import { createMatch, ENGINE_VERSION, reduceMatch, type MatchConfig, type MatchEvent, type MatchState } from '../../../packages/domain/src/index';
import { romaFixture } from '../../../packages/testing/src/index';
import type { VerifiedIdentity } from './oidc';
import { createPreparationState, reducePreparation, trainingAttendanceEvidence, type PreparationCommand, type PreparationState, type PositionCode, type AvailabilityResponse } from '../../../packages/application/src/preparation';
import { applyCommunityCommand, createCommunityState, getCommunityView, authorizeCommunityMedia, communityCanAccess, type CommunityActor, type CommunityCommand, type CommunityState } from '../../../packages/application/src/community';
import { createRecordsSeed, reduceRecords, type RecordsState, type RecordsViewer } from '../../../packages/application/src/records';
import { effectiveEventTime } from '../../../packages/application/src/sync';
import { fixtureMatchConfig } from '../../../packages/application/src/application';
import { applyConfigurationServiceCommand, configurationServiceView, planSeasonRollover, seasonRolloverOptions, type SeasonRolloverCommand, type SeasonRolloverContext } from '../../../packages/application/src/season-service';
import { applyRecordsServiceCommand, recordsServiceExport, recordsServiceView, type RecordsExportRequest, type RecordsServiceCommand, type RecordsServiceInput } from '../../../packages/application/src/records-service';
import { issueClockChallenge as makeClockChallenge, acknowledgeClockChallenge as acceptClockChallenge, type ClockChallenge, type ContinuousUtcMapping, type TrustedTimePolicy } from './trusted-time';
import { Q08_RECONCILIATION_POLICY, previewReconciliation, type ReconciliationProposal, type ReconciliationProposalInput, type ReconciliationSnapshot, type ReconciliationSubmission } from '../../../packages/application/src/reconciliation';
import { deriveFinishedMatchContext, finishEligibilityChanged } from './finished-match-context';
import { createTeamNotificationJob, type TeamNotificationCategory } from '../../../packages/application/src/team-notifications';
import { PUSH_SQLITE_MIGRATION } from './sqlite-push-registrations';
import { managerRoster as projectManagerRoster, type StaffAccountEvidence } from '../../../packages/application/src/staff';
import { prepareAccountPrivacyRequest, projectAccountPrivacyRequests, type PrivacyRequestRecord } from '../../../packages/application/src/privacy-requests';
import { brandSelectedRole,type BrandingAuthority } from './brand-repository';
import { ownDevicesDto,parseNativeDeviceInput,type NativeDeviceRow } from './devices';

export const EVENT_CONTRACT_VERSION = 'longball.events/1.1';
export const SYNTHETIC_IDS = { teamId: 'synthetic-roma-u10', seasonId: 'synthetic-season-2026-27', matchId: 'synthetic-roma-maple-2026-10-24' } as const;
export interface EventEnvelope {
  contractVersion: typeof EVENT_CONTRACT_VERSION;
  schemaVersion: 1;
  engineVersion: string;
  eventId: string;
  matchId: string;
  deviceId: string;
  controllerEpoch: number;
  clientSequence: number;
  previousEventId: string | null;
  baseRevision: number;
  effectiveHalf: 0 | 1 | 2;
  halfElapsedMs: number;
  matchElapsedMs: number;
  effectiveAt: string | null;
  recordedAt: string;
  timeQuality: 'anchored' | 'estimated' | 'reviewRequired';
  clockEvidence: { monotonicMs: number; anchorId: string; continuityId: string | null };
  command: MatchEvent;
}
interface AccountRow { id: string; issuer: string; subject: string; classification: Principal['identityClassification']; adult_verified: number; strong_auth_enrolled: number; status: Principal['status'] }
interface MatchRow { id: string; team_id: string; season_id: string; config_json: string; state_json: string; sharing_policy_json: string; last_sync_at: number | null }
interface GrantRow { match_id: string; epoch: number; account_id: string; device_id: string; capability_hash: string; frozen: number }
interface EventRow { event_id: string; match_id: string; device_id: string; client_sequence: number; envelope_json: string; signature: string; disposition: string; reason: string | null; revision: number | null }
interface StreamRow { sequence: number; previous_event_id: string }
export interface UploadResult { eventId: string; clientSequence: number; disposition: 'accepted' | 'quarantined'; reason: string | null; revision: number | null; duplicate: boolean }
export type OwnPreparationCommand = { id: string; expectedRevision: number } & (
  | { type: 'own.preferences_saved'; preferences: PositionCode[] }
  | { type: 'own.fixture_response_recorded'; fixtureId: string; response: AvailabilityResponse }
  | { type: 'own.training_response_recorded'; trainingId: string; response: AvailabilityResponse }
);

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 150 && /^[a-zA-Z0-9_-]+$/.test(value);
const validDeviceId = (value: unknown): value is string => validId(value) && value.length <= 120;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function bad(message: string): never { throw new AccessError('INVALID_REQUEST', 400, message); }
export function validateEnvelope(value: unknown, matchId: string): EventEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('An event envelope is required.');
  const item = value as EventEnvelope;
  if (!validId(item.eventId) || !validDeviceId(item.deviceId) || item.matchId !== matchId || !nonnegative(item.clientSequence) || item.clientSequence < 1 || !nonnegative(item.controllerEpoch) || item.controllerEpoch < 1 || !nonnegative(item.baseRevision)) bad('Invalid event identity, scope or sequence.');
  if (!(item.previousEventId === null || validId(item.previousEventId))) bad('Invalid previous event identifier.');
  // Reserve the identifiable stream position and original bytes of unsupported versions for recovery.
  if (item.contractVersion !== EVENT_CONTRACT_VERSION || item.schemaVersion !== 1 || item.engineVersion !== ENGINE_VERSION) return item;
  const fields = ['contractVersion', 'schemaVersion', 'engineVersion', 'eventId', 'matchId', 'deviceId', 'controllerEpoch', 'clientSequence', 'previousEventId', 'baseRevision', 'effectiveHalf', 'halfElapsedMs', 'matchElapsedMs', 'effectiveAt', 'recordedAt', 'timeQuality', 'clockEvidence', 'command'];
  if (Object.keys(item).some(key => !fields.includes(key))) bad('Unknown event envelope fields are not accepted.');
  if (!nonnegative(item.halfElapsedMs) || !nonnegative(item.matchElapsedMs) || ![0, 1, 2].includes(item.effectiveHalf)) bad('Invalid effective playing-time boundary.');
  if (!['anchored', 'estimated', 'reviewRequired'].includes(item.timeQuality) || !Number.isFinite(Date.parse(item.recordedAt)) || !(item.effectiveAt === null || Number.isFinite(Date.parse(item.effectiveAt)))) bad('Invalid event time evidence.');
  const command = item.command;
  if (!command || typeof command !== 'object' || command.id !== item.eventId || !command.sample || !Number.isFinite(command.sample.monotonicMs) || command.sample.monotonicMs < 0 || !validId(command.sample.sessionId) || !nonnegative(command.sample.wallTimeMs)) bad('Invalid versioned match command.');
  if (!item.clockEvidence || item.clockEvidence.monotonicMs !== command.sample.monotonicMs || !validId(item.clockEvidence.anchorId) || !(item.clockEvidence.continuityId === null || validId(item.clockEvidence.continuityId))) bad('Explicit clock evidence is required.');
  const commandTypes = ['attendance.recorded', 'availability.changed', 'lineup.staged', 'half.started', 'half.paused', 'half.resumed', 'half.ended', 'lineup.committed', 'goal.recorded', 'clock.recovery_required', 'clock.corrected', 'event.corrected', 'event.voided', 'policy.changed', 'match.abandoned'];
  if (!commandTypes.includes(command.type)) bad('Unsupported match command.');
  if (command.type === 'goal.recorded' && !['us', 'opposition'].includes(command.beneficiary)) bad('Invalid goal side.');
  if (command.type === 'attendance.recorded' && (!validId(command.playerId) || !['present', 'absent', 'excused', 'not_selected', 'not_recorded'].includes(command.status))) bad('Invalid attendance.');
  if (command.type === 'availability.changed' && (!validId(command.playerId) || typeof command.available !== 'boolean')) bad('Invalid availability.');
  if ((command.type === 'lineup.staged' || command.type === 'lineup.committed') && (!Array.isArray(command.lineup) || command.lineup.length > 11 || command.lineup.some(item => !validId(item.playerId) || !validId(item.slotId) || typeof item.position !== 'string' || item.position.length > 30))) bad('Invalid lineup allocations.');
  return item;
}

/** Local synthetic integration store. SQLite is not a substitute for the prepared PostgreSQL production migration. */
export class DevelopmentStore {
  readonly database: DatabaseSync;
  constructor(readonly path: string, readonly now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      this.migrate();
    } catch (error) { this.database.close(); throw error; }
  }
  close(): void { this.database.close(); }
  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  migrate(): void {
    this.transaction(() => {
    // Read the version only after acquiring the migration lock; API and worker can start together.
    const version = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > 10) throw new Error('This store version is newer than this application; preserve it and use a compatible build.');
    if (version === 0) this.database.exec(`
      CREATE TABLE accounts(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,classification TEXT NOT NULL CHECK(classification IN ('child_shared','adult_individual','unclassified')),adult_verified INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',UNIQUE(issuer,subject));
      CREATE TABLE teams(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE memberships(account_id TEXT NOT NULL REFERENCES accounts(id),team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,role TEXT NOT NULL,player_id TEXT,expires_at INTEGER,revoked_at INTEGER,PRIMARY KEY(account_id,team_id,season_id,role));
      CREATE TABLE matches(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,config_json TEXT NOT NULL,state_json TEXT NOT NULL,sharing_policy_json TEXT NOT NULL,last_sync_at INTEGER);
      CREATE TABLE controller_grants(match_id TEXT PRIMARY KEY REFERENCES matches(id),epoch INTEGER NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),device_id TEXT NOT NULL,capability_hash TEXT NOT NULL,frozen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE controller_history(id TEXT PRIMARY KEY,match_id TEXT NOT NULL,epoch INTEGER NOT NULL,actor_id TEXT NOT NULL,from_device TEXT,to_device TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE events(event_id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),device_id TEXT NOT NULL,client_sequence INTEGER NOT NULL,envelope_json TEXT NOT NULL,signature TEXT NOT NULL,disposition TEXT NOT NULL,reason TEXT,revision INTEGER,received_at INTEGER NOT NULL,UNIQUE(match_id,device_id,client_sequence));
      CREATE TABLE streams(match_id TEXT NOT NULL REFERENCES matches(id),device_id TEXT NOT NULL,sequence INTEGER NOT NULL,previous_event_id TEXT NOT NULL,PRIMARY KEY(match_id,device_id));
      CREATE TABLE conflicting_submissions(id TEXT PRIMARY KEY,match_id TEXT NOT NULL,actor_id TEXT NOT NULL,original_json TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE transfers(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),from_epoch INTEGER NOT NULL,to_account_id TEXT NOT NULL,to_device_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE idempotency(account_id TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,signature TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(account_id,operation,key));
      CREATE TABLE audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,object_id TEXT NOT NULL,outcome TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE privacy_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,status TEXT NOT NULL,policy_version TEXT,verified_at INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,business_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,payload_json TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,last_error_code TEXT);
      CREATE INDEX pending_jobs ON jobs(state,due_at);
      CREATE INDEX match_event_order ON events(match_id,revision);
      PRAGMA user_version=1;
    `);
    if (version < 2) this.database.exec(`
      CREATE TABLE documents(team_id TEXT NOT NULL REFERENCES teams(id),season_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(team_id,season_id,kind));
      PRAGMA user_version=2;
    `);
    if (version < 3) this.database.exec('ALTER TABLE accounts ADD COLUMN strong_auth_enrolled INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;');
    if (version < 4) this.database.exec('CREATE TABLE devices(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id)); PRAGMA user_version=4;');
    if (version < 5) this.database.exec('ALTER TABLE events ADD COLUMN actor_id TEXT REFERENCES accounts(id); PRAGMA user_version=5;');
    if (version < 6) this.database.exec(`
      CREATE TABLE clock_challenges(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),account_id TEXT NOT NULL REFERENCES accounts(id),challenge_json TEXT NOT NULL,consumed_at INTEGER);
      CREATE TABLE clock_mappings(challenge_id TEXT PRIMARY KEY REFERENCES clock_challenges(id),match_id TEXT NOT NULL REFERENCES matches(id),mapping_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE reconciliation_proposals(id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),actor_id TEXT NOT NULL REFERENCES accounts(id),signature TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      PRAGMA user_version=6;
    `);
    if (version < 7) this.database.exec(`
      ALTER TABLE privacy_requests ADD COLUMN team_id TEXT REFERENCES teams(id);
      ALTER TABLE privacy_requests ADD COLUMN season_id TEXT;
      ALTER TABLE privacy_requests ADD COLUMN affected_memberships_json TEXT;
      UPDATE privacy_requests SET status='needs_scope' WHERE kind='leave_team' AND status='pending_verification_and_policy' AND (team_id IS NULL OR season_id IS NULL);
      CREATE TABLE privacy_pending_keys(business_key TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES privacy_requests(id));
      INSERT INTO privacy_pending_keys(business_key,request_id)
        SELECT json_array(account_id,kind,'all_memberships'),id FROM (
          SELECT id,account_id,kind,ROW_NUMBER() OVER(PARTITION BY account_id,kind ORDER BY created_at,id) AS n
          FROM privacy_requests WHERE status='pending_verification_and_policy' AND kind IN ('export','delete_account')
        ) WHERE n=1;
      PRAGMA user_version=7;
    `);
    if(version<8)this.database.exec(`CREATE TABLE native_app_devices(device_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),issuer TEXT NOT NULL,platform TEXT NOT NULL CHECK(platform IN('ios','android')),registered_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=registered_at));
      CREATE TRIGGER native_device_identity_immutable BEFORE UPDATE ON native_app_devices WHEN NEW.device_id<>OLD.device_id OR NEW.account_id<>OLD.account_id OR NEW.issuer<>OLD.issuer OR NEW.registered_at<>OLD.registered_at BEGIN SELECT RAISE(ABORT,'Immutable native device identity'); END;
      PRAGMA user_version=8;`);
    if(version<9)this.database.exec(SQLITE_TEAM_PRIVILEGES_DDL + 'PRAGMA user_version=9;');
    if(version<10)this.database.exec(PUSH_SQLITE_MIGRATION + 'PRAGMA user_version=10;');
    });
  }
  async backup(destination: string): Promise<void> {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await backup(this.database, destination);
    chmodSync(destination, 0o600);
  }
  integrity(): string { return String((this.database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check); }
  seedSynthetic(): void {
    this.transaction(() => {
      if (this.database.prepare('SELECT id FROM teams LIMIT 1').get()) return;
      this.database.prepare('INSERT INTO teams(id,name) VALUES(?,?)').run(SYNTHETIC_IDS.teamId, 'Roma U10 · fictional');
      this.database.prepare('INSERT INTO teams(id,name) VALUES(?,?)').run('synthetic-other-team', 'Other fictional team');
      const add = (id: string, classification: Principal['identityClassification'], adult: boolean) => this.database.prepare('INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES(?,?,?,?,?,?)').run(id, 'urn:longball:synthetic', id, classification, Number(adult), Number(adult));
      const membership = (id: string, role: string, playerId: string | null = null, teamId: string = SYNTHETIC_IDS.teamId) => this.database.prepare('INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES(?,?,?,?,?)').run(id, teamId, SYNTHETIC_IDS.seasonId, role, playerId);
      add('synthetic-account-admin', 'adult_individual', true); membership('synthetic-account-admin', 'administrator');
      for (let number = 1; number <= 5; number++) {
        const id = number === 1 ? 'synthetic-account-manager' : `synthetic-account-manager-${number}`; add(id, 'adult_individual', true);
        if (number <= 4) membership(id, 'manager');
        if (number === 1) membership(id, 'administrator');
      }
      for (let number = 1; number <= 13; number++) {
        const suffix = String(number).padStart(2, '0'); const id = `synthetic-account-player-${suffix}`;
        add(id, 'child_shared', false); membership(id, 'player', `synthetic-player-${suffix}`);
      }
      add('synthetic-account-spectator', 'adult_individual', false); membership('synthetic-account-spectator', 'spectator');
      add('synthetic-account-invitee', 'adult_individual', false);
      add('synthetic-account-other-manager', 'adult_individual', true); membership('synthetic-account-other-manager', 'manager', null, 'synthetic-other-team');
      const config: MatchConfig = { matchId: SYNTHETIC_IDS.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.filter(player => player.available).map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: romaFixture.players[0].id };
      this.insertMatch(config, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
      const community = createCommunityState(this.now());
      community.matches = community.matches.map(match => ({ ...match, sharing: 'manager_only' }));
      for (let number = 2; number <= 4; number++) {
        const id = `synthetic-account-manager-${number}`;
        community.accounts.push({ id, label: `Fictional manager ${number}`, classification: 'adult_individual', adultVerified: true });
        community.memberships.push({ accountId: id, teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, role: 'manager', active: true });
      }
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation', createPreparationState());
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', community);
      this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records', createRecordsSeed());
    });
  }
  insertMatch(config: MatchConfig, teamId: string, seasonId: string): void {
    this.database.prepare('INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES(?,?,?,?,?,?)').run(config.matchId, teamId, seasonId, JSON.stringify(config), JSON.stringify(createMatch(config)), JSON.stringify(UNAPPROVED_SHARING_POLICY));
  }
  principal(identity: VerifiedIdentity): Principal {
    const account = this.database.prepare('SELECT * FROM accounts WHERE issuer=? AND subject=?').get(identity.issuer, identity.subject) as AccountRow | undefined;
    if (!account || account.status !== 'active') throw new AccessError('ACCOUNT_UNAVAILABLE', 403, 'The account is not active for this service.');
    return { accountId: account.id, issuer: account.issuer, subject: account.subject, identityClassification: account.classification, adultVerified: Boolean(account.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account.status };
  }
  memberships(): Membership[] {
    const rows = (this.database.prepare('SELECT * FROM memberships').all() as unknown as { account_id: string; team_id: string; season_id: string; role: Membership['role']; player_id: string | null; expires_at: number | null; revoked_at: number | null }[]).map(row => ({ accountId: row.account_id, teamId: row.team_id, seasonId: row.season_id, role: row.role, playerId: row.player_id ?? undefined, expiresAt: row.expires_at, revokedAt: row.revoked_at }));
    const communities = (this.database.prepare("SELECT team_id,season_id,value_json FROM documents WHERE kind='community'").all() as { team_id: string; season_id: string; value_json: string }[]).map(row => ({ ...row, state: JSON.parse(row.value_json) as CommunityState }));
    return rows.map(row => {
      if (row.role !== 'spectator') return row;
      const scope = communities.find(document => document.team_id === row.teamId && document.season_id === row.seasonId);
      // Every endpoint, including match/results DTOs, intersects SQL authority with current grants.
      const granted = scope?.state.grants.some(grant => grant.accountId === row.accountId && grant.teamId === row.teamId && grant.seasonId === row.seasonId && grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      return scope && !granted ? { ...row, revokedAt: row.revokedAt ?? Math.max(1, this.now()) } : row;
    });
  }
  myMemberships(principal: Principal): Membership[] { return currentMemberships(principal, this.memberships(), this.now()); }
  recognisedDevices(principal:Principal){
    const legacy=this.database.prepare('SELECT id,account_id FROM devices WHERE account_id=? ORDER BY id').all(principal.accountId) as unknown as {id:string;account_id:string}[];
    const native=this.database.prepare('SELECT * FROM native_app_devices WHERE account_id=? AND issuer=? ORDER BY registered_at,device_id').all(principal.accountId,principal.issuer) as unknown as NativeDeviceRow[];
    return ownDevicesDto(principal,legacy,native,this.now());
  }
  enrolDevice(principal:Principal,input:unknown){
    const parsed=parseNativeDeviceInput(input);
    if(this.database.prepare('SELECT id FROM devices WHERE id=? AND account_id=?').get(parsed.deviceId,principal.accountId))throw new AccessError('DEVICE_ID_CONFLICT',409,'Use a separate installation identity for sign-in recognition.');
    const previous=this.database.prepare('SELECT account_id,issuer FROM native_app_devices WHERE device_id=?').get(parsed.deviceId);
    if(previous&&(previous.account_id!==principal.accountId||previous.issuer!==principal.issuer))throw new AccessError('DEVICE_ID_CONFLICT',409,'This installation identity is unavailable.');
    this.database.prepare('INSERT INTO native_app_devices(device_id,account_id,issuer,platform,registered_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET platform=excluded.platform,last_seen_at=MAX(native_app_devices.last_seen_at,excluded.last_seen_at)').run(parsed.deviceId,principal.accountId,principal.issuer,parsed.platform,this.now(),this.now());
    return this.recognisedDevices(principal);
  }
  brandingContext(principal:Principal,teamId:string,seasonId:string,role?:string):BrandingAuthority{
    const memberships=this.memberships(),nowMs=this.now(),selectedRole=brandSelectedRole(principal,memberships,teamId,seasonId,role,nowMs);
    const preparation=this.document<PreparationState>(teamId,seasonId,'preparation');
    if(preparation.team.id!==teamId)throw new AccessError('NOT_FOUND',404,'The requested branding is unavailable.');
    return{context:{principal,memberships,selectedRole,clubId:preparation.club.id,teamId,authoritySeasonId:seasonId,nowMs,spectatorGrantActive:selectedRole==='spectator'},club:{id:preparation.club.id,name:preparation.club.name},team:{id:teamId,name:preparation.team.name,ageGroup:preparation.team.ageGroup}};
  }
  match(matchId: string): MatchRow {
    const row = this.database.prepare('SELECT * FROM matches WHERE id=?').get(matchId) as MatchRow | undefined;
    if (!row) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return row;
  }
  managerMatch(principal: Principal, matchId: string): MatchRow {
    const row = this.match(matchId); assertCanManageTeam(principal, this.memberships(), row.team_id, row.season_id, this.now()); return row;
  }
  matchDto(principal: Principal, matchId: string, requestedRole?: string): Record<string, unknown> {
    const row = this.match(matchId);
    return filterMatchForPrincipal({ principal, memberships: this.memberships(), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json) as MatchState, policy: JSON.parse(row.sharing_policy_json) as SharingPolicy, lastSyncAt: row.last_sync_at, now: this.now(), requestedRole });
  }
  download(principal: Principal, matchId: string, deviceId: string): Record<string, unknown> {
    const row = this.managerMatch(principal, matchId);
    if (!validDeviceId(deviceId)) bad('A device identifier of at most 120 canonical characters is required.');
    const stream = this.database.prepare('SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?').get(matchId, deviceId) as StreamRow | undefined;
    const grant = this.database.prepare('SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=?').get(matchId);
    return { contractVersion: EVENT_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, matchId, teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), acceptedRevision: (JSON.parse(row.state_json) as MatchState).revision, deviceCheckpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: grant ?? null, downloadedAt: new Date(this.now()).toISOString(), clockAnchor: { serverTime: new Date(this.now()).toISOString(), quality: 'observation_only', continuousMappingEstablished: false } };
  }
  audit(principal: Principal, action: string, objectId: string, outcome: string): void {
    this.database.prepare('INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), principal.accountId, action, objectId, outcome, this.now());
  }
  idempotent<T>(principal: Principal, operation: string, key: string, payload: unknown, work: () => T): T {
    if (!validId(key) || key.length < 8) bad('A stable Idempotency-Key is required for mutations.');
    const signature = digest(canonical(payload));
    return this.transaction(() => {
      const prior = this.database.prepare('SELECT signature,response_json FROM idempotency WHERE account_id=? AND operation=? AND key=?').get(principal.accountId, operation, key) as { signature: string; response_json: string } | undefined;
      if (prior) {
        if (prior.signature !== signature) throw new AccessError('IDEMPOTENCY_CONFLICT', 409, 'The idempotency key was already used with different content.');
        return JSON.parse(prior.response_json) as T;
      }
      const response = work();
      this.database.prepare('INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES(?,?,?,?,?)').run(principal.accountId, operation, key, signature, JSON.stringify(response));
      return response;
    });
  }
  acquire(principal: Principal, matchId: string, deviceId: string): Record<string, unknown> {
    this.managerMatch(principal, matchId);
    if (!validDeviceId(deviceId)) bad('A device identifier of at most 120 canonical characters is required.');
    const prior = this.database.prepare('SELECT * FROM controller_grants WHERE match_id=?').get(matchId) as GrantRow | undefined;
    if (prior) throw new AccessError('CONTROLLER_EXISTS', 409, 'This match already has a controller. Use handover or audited recovery.');
    this.bindDevice(principal, deviceId);
    const token = randomBytes(32).toString('base64url');
    this.database.prepare('INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES(?,?,?,?,?)').run(matchId, 1, principal.accountId, deviceId, digest(token));
    this.audit(principal, 'controller.acquired', matchId, 'accepted');
    return { epoch: 1, deviceId, controllerToken: token, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint };
  }
  assertController(principal: Principal, matchId: string, token: string | undefined): GrantRow {
    this.managerMatch(principal, matchId);
    const grant = this.database.prepare('SELECT * FROM controller_grants WHERE match_id=?').get(matchId) as GrantRow | undefined;
    if (!grant || grant.account_id !== principal.accountId || !token || digest(token) !== grant.capability_hash) throw new AccessError('CONTROLLER_REQUIRED', 409, 'Only the selected manager and enrolled device may write this match.');
    return grant;
  }
  issueClockChallenge(principal: Principal, matchId: string, token: string | undefined, input: { deviceId:string;controllerEpoch:number;continuityId:string }, policy:TrustedTimePolicy|undefined): ClockChallenge {
    const grant=this.assertController(principal,matchId,token);
    if (!policy) throw new AccessError('CLOCK_POLICY_REQUIRED',503,'An explicitly configured trusted-time policy is required before establishing an anchor.');
    if (!input || Object.keys(input).some(key=>!['deviceId','controllerEpoch','continuityId'].includes(key)) || !validDeviceId(input.deviceId) || !validId(input.continuityId) || input.deviceId!==grant.device_id || input.controllerEpoch!==grant.epoch || grant.frozen) throw new AccessError('CLOCK_SCOPE_CONFLICT',409,'Use the current unfrozen controller device, epoch and continuous-clock identity.');
    const challenge=makeClockChallenge({accountId:principal.accountId,deviceId:grant.device_id,matchId,controllerEpoch:grant.epoch,continuityId:input.continuityId},randomUUID(),this.now(),policy);
    this.database.prepare('INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES(?,?,?,?)').run(challenge.id,matchId,principal.accountId,JSON.stringify(challenge));
    return challenge;
  }
  acknowledgeClockChallenge(principal:Principal,matchId:string,token:string|undefined,challengeId:string,sample:{receivedMonotonicMs:number;sentMonotonicMs:number},policy:TrustedTimePolicy|undefined): ContinuousUtcMapping {
    const grant=this.assertController(principal,matchId,token);
    if (!policy) throw new AccessError('CLOCK_POLICY_REQUIRED',503,'An explicitly configured trusted-time policy is required before establishing an anchor.');
    if (!sample || Object.keys(sample).some(key=>!['receivedMonotonicMs','sentMonotonicMs'].includes(key))) bad('Use the documented continuous-clock receipt and send observations.');
    const row=this.database.prepare('SELECT challenge_json,consumed_at FROM clock_challenges WHERE id=? AND match_id=? AND account_id=?').get(challengeId,matchId,principal.accountId) as {challenge_json:string;consumed_at:number|null}|undefined;
    if(!row)throw new AccessError('NOT_FOUND',404,'That challenge is unavailable.');
    const challenge=JSON.parse(row.challenge_json) as ClockChallenge;
    if(row.consumed_at!==null)throw new AccessError('CLOCK_CHALLENGE_CONSUMED',409,'That clock exchange was consumed. Retrying the same request key returns its receipt.');
    if(challenge.controllerEpoch!==grant.epoch||challenge.deviceId!==grant.device_id||grant.frozen)throw new AccessError('CLOCK_SCOPE_CONFLICT',409,'The controller changed before the clock exchange completed.');
    let mapping:ContinuousUtcMapping;
    try {mapping=acceptClockChallenge(challenge,sample,this.now(),policy);}catch{throw new AccessError('CLOCK_EXCHANGE_REJECTED',422,'The clock exchange expired or its evidence exceeds the configured uncertainty bounds.');}
    this.database.prepare('UPDATE clock_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(this.now(),challengeId);
    this.database.prepare('INSERT INTO clock_mappings(challenge_id,match_id,mapping_json,created_at) VALUES(?,?,?,?)').run(challengeId,matchId,JSON.stringify(mapping),this.now());
    this.audit(principal,'clock.mapping_established',matchId,policy.id);
    return mapping;
  }
  reconciliation(principal:Principal,matchId:string):ReconciliationSnapshot {
    const row=this.managerMatch(principal,matchId);const state=JSON.parse(row.state_json) as MatchState;
    const events=this.database.prepare("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=? AND disposition='quarantined' ORDER BY received_at,client_sequence").all(matchId) as {event_id:string;device_id:string;client_sequence:number;envelope_json:string;reason:string;received_at:number}[];
    const conflicts=this.database.prepare('SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=? ORDER BY created_at,id').all(matchId) as {id:string;original_json:string;reason:string;created_at:number}[];
    const submissions:ReconciliationSubmission[]=[...events.map(event=>{const original=JSON.parse(event.envelope_json) as EventEnvelope;return {submissionId:event.event_id,matchId,eventId:event.event_id,deviceId:event.device_id,clientSequence:event.client_sequence,controllerEpoch:original.controllerEpoch??null,reason:event.reason,original,originalDigest:digest(canonical(original)),receivedAt:new Date(event.received_at).toISOString()};}),...conflicts.map(conflict=>{const original=JSON.parse(conflict.original_json) as Partial<EventEnvelope>;return {submissionId:conflict.id,matchId,eventId:typeof original.eventId==='string'?original.eventId:null,deviceId:typeof original.deviceId==='string'?original.deviceId:null,clientSequence:typeof original.clientSequence==='number'?original.clientSequence:null,controllerEpoch:typeof original.controllerEpoch==='number'?original.controllerEpoch:null,reason:conflict.reason,original,originalDigest:digest(canonical(original)),receivedAt:new Date(conflict.created_at).toISOString()};})];
    const proposals=(this.database.prepare('SELECT receipt_json FROM reconciliation_proposals WHERE match_id=? ORDER BY created_at,id').all(matchId) as {receipt_json:string}[]).map(item=>JSON.parse(item.receipt_json) as ReconciliationProposal);
    return {matchId,acceptedRevision:state.revision,submissions,proposals,policy:Q08_RECONCILIATION_POLICY};
  }
  proposeReconciliation(principal:Principal,matchId:string,input:ReconciliationProposalInput):ReconciliationProposal {
    const row=this.managerMatch(principal,matchId);const state=JSON.parse(row.state_json) as MatchState;
    if(!input||Object.keys(input).some(key=>!['proposalId','baseRevision','sourceSubmissionIds','reason','resolution','commands'].includes(key)))bad('Use only the documented immutable reconciliation proposal fields.');
    const signature=digest(canonical(input));
    const existing=this.database.prepare('SELECT signature,receipt_json FROM reconciliation_proposals WHERE id=? AND match_id=? AND actor_id=?').get(input.proposalId,matchId,principal.accountId) as {signature:string;receipt_json:string}|undefined;
    if(existing){if(existing.signature!==signature)throw new AccessError('RECONCILIATION_PROPOSAL_CONFLICT',409,'That proposal identity already preserves different review evidence.');return JSON.parse(existing.receipt_json) as ReconciliationProposal;}
    const snapshot=this.reconciliation(principal,matchId);const preview=previewReconciliation(state,input,snapshot.submissions,{actorId:principal.accountId,recordedAtMs:this.now()});
    if(!preview.valid)throw new AccessError('RECONCILIATION_PREVIEW_REJECTED',422,preview.issues.join(' ').slice(0,1500));
    const {projectedState:discarded,...savedPreview}=preview;void discarded;
    const receipt:ReconciliationProposal={input,matchId,actorId:principal.accountId,createdAt:new Date(this.now()).toISOString(),sourceDigests:input.sourceSubmissionIds.map(id=>({submissionId:id,originalDigest:snapshot.submissions.find(item=>item.submissionId===id)!.originalDigest})),acceptedStateDigest:digest(canonical(state)),preview:savedPreview,status:'prepared',appliedRevision:null};
    this.database.prepare('INSERT INTO reconciliation_proposals(id,match_id,actor_id,signature,receipt_json,created_at) VALUES(?,?,?,?,?,?)').run(input.proposalId,matchId,principal.accountId,signature,JSON.stringify(receipt),this.now());
    this.audit(principal,'reconciliation.proposal_prepared',matchId,'q08_authority_unapproved');return receipt;
  }
  recordFinishedContext(principal:Principal,matchId:string,policy:TrustedTimePolicy|undefined):{status:string;finishQuality?:string} {
    const row=this.managerMatch(principal,matchId);const state=JSON.parse(row.state_json) as MatchState;
    if(state.status!=='completed')return {status:'not_finished'};
    this.refreshDetailedArchive(row,state);
    const community=this.communityState(row.team_id,row.season_id);
    const existing=community.matches.find(item=>item.id===matchId);
    const quarantine=this.database.prepare("SELECT event_id FROM events WHERE match_id=? AND disposition='quarantined' LIMIT 1").get(matchId);
    const conflict=this.database.prepare('SELECT id FROM conflicting_submissions WHERE match_id=? LIMIT 1').get(matchId);
    const unresolved=Boolean(quarantine||conflict);
    if(existing){
      const retainedFinishId=state.eventHistory?.filter(event=>event.type==='half.ended').at(-1)?.id;
      const retainedFinish=retainedFinishId?this.database.prepare("SELECT envelope_json FROM events WHERE event_id=? AND match_id=? AND disposition='accepted'").get(retainedFinishId,matchId) as {envelope_json:string}|undefined:undefined;
      const currentGrant=this.database.prepare('SELECT epoch FROM controller_grants WHERE match_id=?').get(matchId) as {epoch:number}|undefined;
      const sourceEpoch=retainedFinish?(JSON.parse(retainedFinish.envelope_json) as EventEnvelope).controllerEpoch:null;
      const quality=unresolved?'conflicted':state.recoveryRequired||sourceEpoch!==currentGrant?.epoch||finishEligibilityChanged(state,existing)?'review_required':existing.finishQuality;
      if(quality!==existing.finishQuality){
        const next:CommunityState={...community,revision:community.revision+1,matches:community.matches.map(match=>match.id===matchId?{...match,finishQuality:quality}:match),audit:[...community.audit,{id:randomUUID(),actorAccountId:null,action:'service.finish_evidence_flagged_without_reopening',atMs:this.now()}]};
        this.saveDocument(row.team_id,row.season_id,'community',next);
      }
      return {status:'original_context_preserved',finishQuality:quality};
    }
    const finishId=state.eventHistory?.filter(event=>event.type==='half.ended').at(-1)?.id;
    const finishRow=finishId?this.database.prepare("SELECT envelope_json,actor_id FROM events WHERE event_id=? AND match_id=? AND disposition='accepted'").get(finishId,matchId) as {envelope_json:string;actor_id:string|null}|undefined:undefined;
    const finish=finishRow?JSON.parse(finishRow.envelope_json) as EventEnvelope:null;
    const mappingRow=finish?this.database.prepare('SELECT mapping_json FROM clock_mappings WHERE challenge_id=? AND match_id=?').get(finish.clockEvidence.anchorId,matchId) as {mapping_json:string}|undefined:undefined;
    const grant=this.database.prepare('SELECT epoch FROM controller_grants WHERE match_id=?').get(matchId) as {epoch:number}|undefined;
    const preparation=this.document<PreparationState>(row.team_id,row.season_id,'preparation');
    const fixture=preparation.fixtures.find(item=>item.id===matchId&&item.seasonId===row.season_id);
    const playedDate=state.config.fixture?.playedDate??fixture?.playedDate;
    if(!playedDate)return {status:'accepted_fixture_date_required'};
    // A saved calendar date is a schedule sort key, never an observed kickoff or actual full time.
    const scheduledAtMs=Date.parse(`${playedDate}T00:00:00Z`);
    const context=deriveFinishedMatchContext({state,acceptedFinish:finish,acceptedFinishActorId:finishRow?.actor_id??null,teamId:row.team_id,seasonId:row.season_id,currentControllerEpoch:grant?.epoch??0,unresolvedConflicts:unresolved,mapping:mappingRow?JSON.parse(mappingRow.mapping_json) as ContinuousUtcMapping:null,policy:policy??null,serverNowMs:this.now(),scheduledAtMs,sharing:'manager_only',sharingPolicyVersion:0});
    const next:CommunityState={...community,revision:community.revision+1,matches:[...community.matches,{...context,voteCutoffAtMs:null,cutoffSource:'unresolved',finalisationDeadlineAtMs:context.actualFullTimeAtMs===null?null:context.actualFullTimeAtMs+3_600_000}],audit:[...community.audit,{id:randomUUID(),actorAccountId:null,action:'service.accepted_finish_registered_manager_only',atMs:this.now()}]};
    this.saveDocument(row.team_id,row.season_id,'community',next);
    return {status:'registered_from_accepted_history',finishQuality:context.finishQuality};
  }
  private refreshDetailedArchive(row:MatchRow,match:MatchState):void{
    const saved=this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='records'").get(row.team_id,row.season_id) as {value_json:string}|undefined;
    if(!saved)return;
    const records=JSON.parse(saved.value_json) as RecordsState;const archived=records.results.find(item=>item.id===match.config.matchId&&item.recordMode==='detailed_live');
    if(!archived||(archived.sourceMatchRevision??-1)>=match.revision)return;
    if(match.recoveryRequired){
      if(archived.detailCompleteness!=='review_required'){const reviewed:RecordsState={...records,revision:records.revision+1,results:records.results.map(item=>item.id===archived.id?{...item,detailCompleteness:'review_required',revision:item.revision+1}:item)};this.saveDocument(row.team_id,row.season_id,'records',reviewed);}
      return;
    }
    const context={matchId:archived.id,playedDate:archived.playedDate,opponent:archived.opponent,homeAway:archived.homeAway,fixtureClass:archived.fixtureClass};
    const updated=reduceRecords({...records,liveMatch:context},{type:'live.archive',commandId:`accepted-archive-${digest(canonical([archived.id,match.revision]))}`,at:new Date(this.now()).toISOString(),actor:'manager',match,reason:'Existing detailed archive refreshed from the newer accepted canonical match revision; original source events and prior archive audit remain retained.'});
    const projected:RecordsState={...updated,liveMatch:records.liveMatch};this.saveDocument(row.team_id,row.season_id,'records',projected);
  }
  upload(principal: Principal, matchId: string, token: string | undefined, values: unknown[]): { results: UploadResult[]; revision: number; pendingReview: boolean } {
    const row = this.managerMatch(principal, matchId);
    if (!Array.isArray(values) || values.length === 0 || values.length > 100) bad('Upload between one and 100 ordered events.');
    const grant = this.database.prepare('SELECT * FROM controller_grants WHERE match_id=?').get(matchId) as GrantRow | undefined;
    // An old manager's fenced branch is retained but can never affect the accepted projection.
    const currentCapability = !!grant && grant.account_id === principal.accountId && !!token && digest(token) === grant.capability_hash;
    let state = JSON.parse(row.state_json) as MatchState;
    const results: UploadResult[] = [];
    for (const value of values) {
      const event = validateEnvelope(value, matchId);
      const device = this.database.prepare('SELECT account_id FROM devices WHERE id=?').get(event.deviceId) as { account_id: string } | undefined;
      if (!device || device.account_id !== principal.accountId) throw new AccessError('DEVICE_BINDING_REQUIRED', 403, 'This event device is not enrolled to the authenticated account.');
      const signature = digest(canonical(event));
      const previous = this.database.prepare('SELECT * FROM events WHERE event_id=?').get(event.eventId) as EventRow | undefined;
      if (previous) {
        if (previous.match_id !== matchId || previous.signature !== signature) {
          this.database.prepare('INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)').run(randomUUID(), matchId, principal.accountId, JSON.stringify(value), 'EVENT_ID_CONFLICT', this.now());
          results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: 'quarantined', reason: 'EVENT_ID_CONFLICT', revision: null, duplicate: false });
        } else results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition as UploadResult['disposition'], reason: previous.reason, revision: previous.revision, duplicate: true });
        continue;
      }
      const stream = this.database.prepare('SELECT sequence,previous_event_id FROM streams WHERE match_id=? AND device_id=?').get(matchId, event.deviceId) as StreamRow | undefined;
      if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
        this.database.prepare('INSERT INTO conflicting_submissions VALUES(?,?,?,?,?,?)').run(randomUUID(), matchId, principal.accountId, JSON.stringify(value), 'SEQUENCE_GAP_OR_REUSE', this.now());
        results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: 'quarantined', reason: 'SEQUENCE_GAP_OR_REUSE', revision: null, duplicate: false });
        continue;
      }
      let reason: string | null = null;
      if (event.contractVersion !== EVENT_CONTRACT_VERSION || event.schemaVersion !== 1 || event.engineVersion !== ENGINE_VERSION) reason = 'UNSUPPORTED_EVENT_VERSION';
      else if (!grant || !currentCapability || event.controllerEpoch !== grant.epoch || event.deviceId !== grant.device_id) reason = 'STALE_CONTROLLER';
      else if (grant.frozen) reason = 'HANDOVER_WRITES_FROZEN';
      else if (event.baseRevision !== state.revision) reason = 'STALE_REVISION';
      if (!reason) {
        try {
          const next = reduceMatch(state, { ...event.command, actorId: principal.accountId });
          // Preserve true effective boundaries for late entries and compensating corrections.
          // The accepted projection's checkpoint is derived separately by replay.
          const effective = effectiveEventTime(state, next, event.command);
          if (effective.half !== event.effectiveHalf || effective.halfElapsedMs !== event.halfElapsedMs || effective.matchElapsedMs !== event.matchElapsedMs) throw new Error('Effective playing-time evidence differs from the command.');
          state = next;
        } catch { reason = 'INVALID_MATCH_TRANSITION'; }
      }
      const disposition = reason ? 'quarantined' : 'accepted';
      const revision = reason ? null : state.revision;
      this.database.prepare('INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(event.eventId, matchId, event.deviceId, event.clientSequence, JSON.stringify(event), signature, disposition, reason, revision, this.now(), principal.accountId);
      this.database.prepare('INSERT INTO streams(match_id,device_id,sequence,previous_event_id) VALUES(?,?,?,?) ON CONFLICT(match_id,device_id) DO UPDATE SET sequence=excluded.sequence,previous_event_id=excluded.previous_event_id').run(matchId, event.deviceId, event.clientSequence, event.eventId);
      results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition, reason, revision, duplicate: false });
    }
    if (results.some(item => item.disposition === 'accepted' && !item.duplicate)) this.database.prepare('UPDATE matches SET state_json=?,last_sync_at=? WHERE id=?').run(JSON.stringify(state), this.now(), matchId);
    this.audit(principal, 'events.uploaded', matchId, results.some(item => item.disposition === 'quarantined') ? 'review_required' : 'accepted');
    if(results.some(item=>item.disposition==='accepted'&&!item.duplicate))this.enqueueNotifications(row.team_id,row.season_id,'match',matchId,`accepted-revision-${state.revision}`);
    return { results, revision: state.revision, pendingReview: results.some(item => item.disposition === 'quarantined') };
  }
  quarantine(principal: Principal, matchId: string): unknown[] {
    this.managerMatch(principal, matchId);
    return [...this.database.prepare("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=? AND disposition='quarantined' ORDER BY received_at,client_sequence").all(matchId), ...this.database.prepare('SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=? ORDER BY created_at').all(matchId)];
  }
  offerHandover(principal: Principal, matchId: string, token: string | undefined, toAccountId: string, toDeviceId: string, baseRevision: number): Record<string, unknown> {
    const row = this.managerMatch(principal, matchId); const grant = this.assertController(principal, matchId, token);
    if (grant.frozen) throw new AccessError('TRANSFER_PENDING', 409, 'A controller transfer is already pending.');
    const state = JSON.parse(row.state_json) as MatchState;
    if (state.revision !== baseRevision) throw new AccessError('STALE_REVISION', 409, 'Synchronise the accepted checkpoint before handover.');
    if (state.status.endsWith('_running')) throw new AccessError('CLOCK_ANCHOR_REQUIRED', 409, 'Running handover requires a verified UTC/device clock exchange. This development service supports handover while the match clock is already paused, at half-time or before kick-off; it never silently pauses play.');
    if (!validId(toAccountId) || !validDeviceId(toDeviceId)) bad('A target account and canonical device identifier of at most 120 characters are required.');
    const target = this.database.prepare('SELECT * FROM accounts WHERE id=?').get(toAccountId) as AccountRow | undefined;
    if (!target) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, this.memberships(), row.team_id, row.season_id, this.now());
    const id = randomUUID();
    this.database.prepare('INSERT INTO transfers VALUES(?,?,?,?,?,?,?)').run(id, matchId, grant.epoch, toAccountId, toDeviceId, 'pending', this.now());
    this.database.prepare('UPDATE controller_grants SET frozen=1 WHERE match_id=?').run(matchId);
    this.audit(principal, 'controller.transfer_offered', matchId, 'pending');
    return { transferId: id, state: 'pending', acceptedRevision: state.revision };
  }
  acceptHandover(principal: Principal, matchId: string, transferId: string, deviceId: string): Record<string, unknown> {
    this.managerMatch(principal, matchId); assertAdultAuthority(principal, false, this.now());
    const transfer = this.database.prepare('SELECT * FROM transfers WHERE id=? AND match_id=?').get(transferId, matchId) as { to_account_id: string; to_device_id: string; from_epoch: number; state: string } | undefined;
    const grant = this.database.prepare('SELECT * FROM controller_grants WHERE match_id=?').get(matchId) as GrantRow | undefined;
    if (!transfer || transfer.to_account_id !== principal.accountId || transfer.to_device_id !== deviceId) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    if (transfer.state !== 'pending' || !grant || grant.epoch !== transfer.from_epoch || !grant.frozen) throw new AccessError('TRANSFER_CONFLICT', 409, 'Check the authoritative transfer status before retrying.');
    this.bindDevice(principal, deviceId);
    const capability = randomBytes(32).toString('base64url'); const epoch = grant.epoch + 1;
    this.database.prepare('UPDATE controller_grants SET epoch=?,account_id=?,device_id=?,capability_hash=?,frozen=0 WHERE match_id=?').run(epoch, principal.accountId, deviceId, digest(capability), matchId);
    this.database.prepare("UPDATE transfers SET state='accepted' WHERE id=?").run(transferId);
    this.database.prepare('INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), matchId, epoch, principal.accountId, grant.device_id, deviceId, 'transferred', null, this.now());
    this.audit(principal, 'controller.transferred', matchId, 'accepted');
    return { epoch, deviceId, controllerToken: capability, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint, acceptedRevision: (JSON.parse(this.match(matchId).state_json) as MatchState).revision };
  }
  recover(principal: Principal, matchId: string, deviceId: string, reason: string): Record<string, unknown> {
    const row = this.managerMatch(principal, matchId); assertAdultAuthority(principal, true, this.now());
    if (!validDeviceId(deviceId) || typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500) bad('Recovery needs a target canonical device identifier of at most 120 characters and a concise audit reason.');
    this.bindDevice(principal, deviceId);
    const old = this.database.prepare('SELECT * FROM controller_grants WHERE match_id=?').get(matchId) as GrantRow | undefined;
    const capability = randomBytes(32).toString('base64url'); const epoch = (old?.epoch ?? 0) + 1;
    const state = JSON.parse(row.state_json) as MatchState;
    // Preserve the projection and evidence. No guessed clock/lineup or destructive reset.
    if (state.status.endsWith('_running')) {
      state.recoveryRequired = true; state.recoveryReason = 'Controller recovery: reconcile the referee clock and any unsynchronised old-device events.';
      this.database.prepare('UPDATE matches SET state_json=? WHERE id=?').run(JSON.stringify(state), matchId);
    }
    this.database.prepare('INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash,frozen) VALUES(?,?,?,?,?,0) ON CONFLICT(match_id) DO UPDATE SET epoch=excluded.epoch,account_id=excluded.account_id,device_id=excluded.device_id,capability_hash=excluded.capability_hash,frozen=0').run(matchId, epoch, principal.accountId, deviceId, digest(capability));
    this.database.prepare("UPDATE transfers SET state='superseded' WHERE match_id=? AND state='pending'").run(matchId);
    this.database.prepare('INSERT INTO controller_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, 'recovered', reason.trim(), this.now());
    this.audit(principal, 'controller.recovered', matchId, 'reconciliation_required');
    return { epoch, deviceId, controllerToken: capability, reconciliationRequired: true, checkpoint: this.download(principal, matchId, deviceId).deviceCheckpoint };
  }
  private staffRevision(teamId:string,seasonId:string):number {
    const row=this.database.prepare("SELECT revision FROM documents WHERE team_id=? AND season_id=? AND kind='staff'").get(teamId,seasonId) as {revision:number}|undefined;
    return row?.revision??0;
  }
  private bumpStaffRevision(teamId:string,seasonId:string):number {
    const revision=this.staffRevision(teamId,seasonId)+1;
    this.saveDocument(teamId,seasonId,'staff',{revision});return revision;
  }
  managers(principal:Principal,teamId:string,seasonId:string,requestedRole?:string):ReturnType<typeof projectManagerRoster> {
    assertTeamRole(principal,this.memberships(),teamId,seasonId,['administrator'],this.now());assertAdultAuthority(principal,false,this.now());
    const accounts=this.database.prepare('SELECT * FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE team_id=?)').all(teamId) as unknown as AccountRow[];
    const community=this.document<CommunityState>(teamId,seasonId,'community');
    const evidence:StaffAccountEvidence[]=accounts.map(account=>({accountId:account.id,label:community.accounts.find(item=>item.id===account.id)?.label??'Verified adult account',status:account.status,identityClassification:account.classification,adultVerified:Boolean(account.adult_verified),strongAuthEnrolled:Boolean(account.strong_auth_enrolled)}));
    return projectManagerRoster({principal,memberships:this.memberships(),accounts:evidence,teamId,seasonId,nowMs:this.now(),revision:this.staffRevision(teamId,seasonId),requestedRole});
  }
  assignManager(actor: Principal, teamId: string, seasonId: string, accountId: string, expectedRevision?:number): Record<string, unknown> {
    assertTeamRole(actor,this.memberships(),teamId,seasonId,['administrator'],this.now());assertAdultAuthority(actor,true,this.now());
    if(!validId(accountId))bad('A canonical account identifier is required.');
    if(expectedRevision!==undefined&&(!nonnegative(expectedRevision)||expectedRevision!==this.staffRevision(teamId,seasonId)))throw new AccessError('STALE_REVISION',409,'Refresh the current staff assignments before changing them.');
    const account = this.database.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as AccountRow | undefined;
    if (!account) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    const target: Principal = { accountId: account.id, issuer: account.issuer, subject: account.subject, identityClassification: account.classification, adultVerified: !!account.adult_verified, strongAuth: !!account.strong_auth_enrolled, authenticatedAt: this.now(), status: account.status };
    assertCanAssignManager(actor, target, this.memberships(), teamId, seasonId, this.now());
    const alreadyActive=this.memberships().some(item=>item.accountId===accountId&&item.teamId===teamId&&item.seasonId===seasonId&&item.role==='manager'&&item.revokedAt==null&&(item.expiresAt==null||item.expiresAt>this.now()));
    if(!alreadyActive){
      this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES(?,?,?,'manager') ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET revoked_at=NULL,expires_at=NULL").run(accountId, teamId, seasonId);
      this.bumpStaffRevision(teamId,seasonId);this.audit(actor, 'manager.assigned', teamId, 'accepted');
    }
    return { accountId, teamId, seasonId, role: 'manager',revision:this.staffRevision(teamId,seasonId),acceptedAt:new Date(this.now()).toISOString() };
  }
  revokeManager(actor:Principal,teamId:string,seasonId:string,input:{accountId:string;reason:string;confirmRevocation:true},expectedRevision?:number):Record<string,unknown>{
    assertTeamRole(actor,this.memberships(),teamId,seasonId,['administrator'],this.now());assertAdultAuthority(actor,true,this.now());
    if(!input||Object.keys(input).some(key=>!['accountId','reason','confirmRevocation'].includes(key))||!validId(input.accountId)||input.confirmRevocation!==true||typeof input.reason!=='string'||input.reason.trim().length<5||input.reason.length>500)bad('Confirm a scoped manager revocation and record its evidence reason.');
    if(expectedRevision!==undefined&&(!nonnegative(expectedRevision)||expectedRevision!==this.staffRevision(teamId,seasonId)))throw new AccessError('STALE_REVISION',409,'Refresh the current staff assignments before changing them.');
    const member=this.database.prepare("SELECT account_id,revoked_at FROM memberships WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").get(input.accountId,teamId,seasonId) as {account_id:string;revoked_at:number|null}|undefined;
    if(!member)throw new AccessError('NOT_FOUND',404,'That manager assignment is outside this scope.');
    if(member.revoked_at===null){
      this.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id=? AND team_id=? AND season_id=? AND role='manager'").run(this.now(),input.accountId,teamId,seasonId);
      this.database.prepare('UPDATE controller_grants SET frozen=1 WHERE account_id=? AND match_id IN (SELECT id FROM matches WHERE team_id=? AND season_id=?)').run(input.accountId,teamId,seasonId);
      this.bumpStaffRevision(teamId,seasonId);this.audit(actor,'manager.assignment_revoked',input.accountId,input.reason.trim());
    }
    return {accountId:input.accountId,teamId,seasonId,role:'manager',revision:this.staffRevision(teamId,seasonId),acceptedAt:new Date(this.now()).toISOString(),revoked:true,controllerFrozen:true,otherSeasonAssignmentsRetained:true,remainingActiveTeamSeasons:this.memberships().filter(item=>item.accountId===input.accountId&&item.teamId===teamId&&item.role==='manager'&&item.revokedAt==null&&(item.expiresAt==null||item.expiresAt>this.now())).map(item=>item.seasonId)};
  }
  private privacyRecords(principal:Principal):PrivacyRequestRecord[]{
    const rows=this.database.prepare('SELECT id,account_id,kind,status,team_id,season_id,affected_memberships_json,created_at FROM privacy_requests WHERE account_id=? ORDER BY created_at,id').all(principal.accountId) as unknown as {id:string;account_id:string;kind:PrivacyRequestRecord['kind'];status:PrivacyRequestRecord['status'];team_id:string|null;season_id:string|null;affected_memberships_json:string|null;created_at:number}[];
    return rows.map(row=>({requestId:row.id,accountId:row.account_id,kind:row.kind,status:row.status,scope:row.kind==='leave_team'?(row.team_id&&row.season_id?{type:'team_season' as const,teamId:row.team_id,seasonId:row.season_id}:null):{type:'all_memberships' as const},affectedMemberships:row.affected_memberships_json===null?null:JSON.parse(row.affected_memberships_json),createdAtMs:row.created_at}));
  }
  privacyRequest(principal:Principal,input:unknown):ReturnType<typeof projectAccountPrivacyRequests>['items'][number]{
    const plan=prepareAccountPrivacyRequest({principal,memberships:this.memberships(),input,nowMs:this.now()});
    const pending=this.database.prepare("SELECT p.id FROM privacy_pending_keys k JOIN privacy_requests p ON p.id=k.request_id WHERE k.business_key=? AND p.account_id=? AND p.status='pending_verification_and_policy'").get(plan.businessKey,principal.accountId) as {id:string}|undefined;
    let requestId=pending?.id;
    if(!requestId){
      const retained=plan.scope.type==='team_season'
        ?this.database.prepare("SELECT id FROM privacy_requests WHERE account_id=? AND kind=? AND team_id=? AND season_id=? AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1").get(principal.accountId,plan.kind,plan.scope.teamId,plan.scope.seasonId) as {id:string}|undefined
        :this.database.prepare("SELECT id FROM privacy_requests WHERE account_id=? AND kind=? AND team_id IS NULL AND season_id IS NULL AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1").get(principal.accountId,plan.kind) as {id:string}|undefined;
      requestId=retained?.id;
    }
    if(!requestId){
      requestId=randomUUID();
      this.database.prepare('INSERT INTO privacy_requests(id,account_id,kind,status,policy_version,verified_at,created_at,team_id,season_id,affected_memberships_json) VALUES(?,?,?,?,NULL,NULL,?,?,?,?)').run(requestId,principal.accountId,plan.kind,plan.status,this.now(),plan.scope.type==='team_season'?plan.scope.teamId:null,plan.scope.type==='team_season'?plan.scope.seasonId:null,JSON.stringify(plan.affectedMemberships));
      this.audit(principal,'privacy.requested',requestId,'pending_verification_and_policy');
    }
    this.database.prepare('INSERT INTO privacy_pending_keys(business_key,request_id) VALUES(?,?) ON CONFLICT(business_key) DO UPDATE SET request_id=excluded.request_id').run(plan.businessKey,requestId);
    return this.privacyRequests(principal).items.find(item=>item.requestId===requestId)!;
  }
  privacyRequests(principal:Principal):ReturnType<typeof projectAccountPrivacyRequests>{
    return projectAccountPrivacyRequests({principal,memberships:this.memberships(),records:this.privacyRecords(principal),nowMs:this.now()});
  }
  /** Explicit setup seam: an authorised operator imports verified provider-to-account mappings; no token creates authority. */
  bindIdentity(accountId: string, issuer: string, subject: string): void { this.database.prepare('UPDATE accounts SET issuer=?,subject=? WHERE id=?').run(issuer, subject, accountId); }
  bindDevice(principal: Principal, deviceId: string): void {
    const device = this.database.prepare('SELECT account_id FROM devices WHERE id=?').get(deviceId) as { account_id: string } | undefined;
    if (device && device.account_id !== principal.accountId) throw new AccessError('DEVICE_ACCOUNT_CONFLICT', 409, 'Enrol a separate device identity for this account.');
    this.database.prepare('INSERT INTO devices(id,account_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(deviceId, principal.accountId);
  }
  teamMatches(principal: Principal, teamId: string, seasonId: string, requestedRole?: string): unknown[] {
    assertTeamRole(principal, this.memberships(), teamId, seasonId, ['manager', 'player', 'spectator'], this.now());
    return (this.database.prepare('SELECT id FROM matches WHERE team_id=? AND season_id=? ORDER BY id LIMIT 100').all(teamId, seasonId) as { id: string }[]).map(row => this.matchDto(principal, row.id, requestedRole));
  }
  document<T>(teamId: string, seasonId: string, kind: string): T {
    const row = this.database.prepare('SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind=?').get(teamId, seasonId, kind) as { value_json: string } | undefined;
    if (!row) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return JSON.parse(row.value_json) as T;
  }
  saveDocument(teamId: string, seasonId: string, kind: string, state: { revision: number }): void {
    this.database.prepare('INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES(?,?,?,?,?) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json').run(teamId, seasonId, kind, state.revision, JSON.stringify(state));
  }
  enqueueNotifications(teamId:string,seasonId:string,category:TeamNotificationCategory,entityId:string,sourceId:string):number{
    const recipients=new Map<string,Membership>();
    const priority={manager:3,player:2,spectator:1,administrator:0};
    for(const member of this.memberships().filter(item=>item.teamId===teamId&&item.seasonId===seasonId&&['manager','player','spectator'].includes(item.role)&&item.revokedAt==null&&(item.expiresAt==null||item.expiresAt>this.now()))){const current=recipients.get(member.accountId);if(!current||priority[member.role]>priority[current.role])recipients.set(member.accountId,member);}
    let inserted=0;
    for(const member of recipients.values()){
      if(member.role==='administrator'||member.role==='player'&&!member.playerId)continue;
      const businessKey=`notify:${digest(canonical([teamId,seasonId,category,entityId,sourceId,member.accountId,member.role]))}`;
      const job=createTeamNotificationJob({id:randomUUID(),businessKey,accountId:member.accountId,teamId,seasonId,audience:member.role,playerId:member.role==='player'?member.playerId!:null,category,entityId,dueAtMs:this.now()});
      const result=this.database.prepare("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,'notification.dispatch',?,?) ON CONFLICT(business_key) DO NOTHING").run(job.id,businessKey,JSON.stringify(job),job.dueAtMs);inserted+=Number(result.changes);
    }
    return inserted;
  }
  preparation(principal: Principal, teamId: string, seasonId: string): PreparationState {
    assertCanManageTeam(principal, this.memberships(), teamId, seasonId, this.now());
    return this.document<PreparationState>(teamId, seasonId, 'preparation');
  }
  configuration(principal: Principal, teamId: string, seasonId: string,role?:string): ReturnType<typeof configurationServiceView> {
    if(role)assertTeamRole(principal,this.memberships(),teamId,seasonId,role==='manager'||role==='administrator'?[role]:[],this.now());
    const state = this.document<PreparationState>(teamId, seasonId, 'preparation');
    return configurationServiceView({principal,memberships:this.memberships(),preparation:state,seasonId,nowMs:this.now()});
  }
  configurationCommand(principal: Principal, teamId: string, seasonId: string, command: PreparationCommand,role?:string): ReturnType<typeof configurationServiceView> {
    this.configuration(principal, teamId, seasonId,role);
    if (!command || !['club.updated', 'team.updated'].includes(command.type)) bad('Only club or team configuration can be changed in this context.');
    if(role&&command.type==='club.updated'&&role!=='administrator')throw new AccessError('NOT_FOUND',404,'Choose the current administrator context to administer the club.');
    const state = applyConfigurationServiceCommand({principal,memberships:this.memberships(),preparation:this.document<PreparationState>(teamId,seasonId,'preparation'),seasonId,nowMs:this.now(),command});
    this.saveDocument(teamId, seasonId, 'preparation', state);
    this.audit(principal, command.type, teamId, 'administrator_configuration_accepted');
    return this.configuration(principal, teamId, seasonId,role);
  }
  private seasonContext(principal: Principal, teamId: string, seasonId: string): SeasonRolloverContext {
    const community = this.communityState(teamId, seasonId);
    const accounts = this.database.prepare('SELECT * FROM accounts').all() as unknown as AccountRow[];
    const preparationDocuments = this.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND kind='preparation'").all(teamId) as { value_json:string }[];
    const existingSeasons = preparationDocuments.flatMap(row => (JSON.parse(row.value_json) as PreparationState).seasons.map(season => ({ teamId,id:season.id,startYear:season.startYear })));
    return { principal, memberships: this.memberships(), existingSeasons, nowMs: this.now(), preparation: this.document<PreparationState>(teamId, seasonId, 'preparation'), records: this.document<RecordsState>(teamId, seasonId, 'records'), community,
      accounts: accounts.map(account => ({ accountId: account.id, label: community.accounts.find(item => item.id === account.id)?.label ?? 'Verified account', status: account.status, identityClassification: account.classification, adultVerified: Boolean(account.adult_verified), strongAuthEnrolled: Boolean(account.strong_auth_enrolled) })) };
  }
  seasonOptions(principal: Principal, teamId: string, seasonId: string): ReturnType<typeof seasonRolloverOptions> { return seasonRolloverOptions(this.seasonContext(principal, teamId, seasonId)); }
  createSeason(principal: Principal, teamId: string, seasonId: string, command: SeasonRolloverCommand): ReturnType<typeof planSeasonRollover>['receipt'] {
    const context = this.seasonContext(principal, teamId, seasonId);
    const plan = planSeasonRollover({ ...context, command });
    if (this.database.prepare('SELECT kind FROM documents WHERE team_id=? AND season_id=? LIMIT 1').get(teamId, plan.receipt.seasonId)) throw new AccessError('SEASON_EXISTS', 409, 'That destination season already has saved documents.');
    for (const member of plan.memberships) this.database.prepare('INSERT INTO memberships(account_id,team_id,season_id,role,player_id,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?)').run(member.accountId, member.teamId, member.seasonId, member.role, member.playerId ?? null, member.expiresAt ?? null, member.revokedAt ?? null);
    this.saveDocument(teamId, plan.receipt.seasonId, 'preparation', plan.preparation);
    this.saveDocument(teamId, plan.receipt.seasonId, 'records', plan.records);
    this.saveDocument(teamId, plan.receipt.seasonId, 'community', plan.community);
    this.audit(principal, 'season.created_from_explicit_assignments', plan.receipt.seasonId, 'accepted_no_spectator_renewal');
    return plan.receipt;
  }
  /** Called inside the preparation mutation transaction; current labels never rewrite saved match evidence. */
  private projectPreparationRecords(teamId: string, seasonId: string, preparation: PreparationState, sourceCommandId: string): void {
    const previous = this.document<RecordsState>(teamId, seasonId, 'records');
    const labels = new Map(previous.players.map(player => [player.id, player]));
    for (const profile of preparation.profiles.filter(profile => profile.seasonId === seasonId)) labels.set(profile.playerId, { id: profile.playerId, label: profile.displayName });
    const players = [...labels.values()];
    const evidence = trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter(session => session.seasonId === seasonId) });
    let records = previous;
    const at = new Date(this.now()).toISOString();
    if (canonical(players) !== canonical(previous.players)) records = { ...records, players, revision: records.revision + 1,
      audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: 'preparation.roster.projected', matchId: null, at, reason: 'Current season roster labels updated from preparation; saved match snapshots preserved.', before: null, after: null }] };
    if (canonical(evidence) !== canonical(previous.trainingAttendance)) records = reduceRecords(records, { type: 'training.evidence.replace', commandId: `preparation-training-${sourceCommandId}`, at, actor: 'manager', evidence });
    if (records !== previous) this.saveDocument(teamId, seasonId, 'records', records);
  }
  preparationCommand(principal: Principal, teamId: string, seasonId: string, command: PreparationCommand): PreparationState {
    const previous = this.preparation(principal, teamId, seasonId);
    const types = ['club.updated', 'team.updated', 'season.rolled_over', 'profile.saved', 'roster.imported', 'profile.archived', 'formation.saved', 'fixture.saved', 'fixture.status_changed', 'fixture.response_recorded', 'fixture.selection_saved', 'fixture.attendance_recorded', 'fixture.prepared', 'match_plan.saved', 'match_plan.applied', 'match_plan.cleared', 'training.series_created', 'training.series_updated', 'training.series_cancelled', 'training.saved', 'training.status_changed', 'training.response_recorded', 'training.attendance_recorded'];
    if (!command || !types.includes(command.type)) bad('Unsupported preparation command.');
    if (command.type === 'season.rolled_over') throw new AccessError('SEASON_ASSIGNMENT_REQUIRED', 503, 'A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.');
    if (command.type === 'club.updated') {
      assertTeamRole(principal, this.memberships(), teamId, seasonId, ['administrator'], this.now());
      assertAdultAuthority(principal, true, this.now());
    }
    const protectedFixtureIds: string[] = [];
    if (command.type === 'match_plan.applied') {
      const match = this.database.prepare('SELECT state_json FROM matches WHERE id=? AND team_id=? AND season_id=?').get(command.fixtureId, teamId, seasonId) as { state_json: string } | undefined;
      if (match) {
        const accepted = JSON.parse(match.state_json) as MatchState;
        if (accepted.status !== 'preparation' || accepted.revision !== 0 || this.database.prepare('SELECT match_id FROM controller_grants WHERE match_id=?').get(command.fixtureId) || this.database.prepare('SELECT event_id FROM events WHERE match_id=? LIMIT 1').get(command.fixtureId)) protectedFixtureIds.push(command.fixtureId);
      }
    }
    const state = reducePreparation(previous, command, { nowMs: this.now(), protectedFixtureIds });
    if (command.type === 'fixture.prepared') {
      const snapshot = state.snapshots.find(snapshot => snapshot.fixtureId === command.fixtureId && snapshot.preparedRevision === command.expectedRevision + 1);
      if (!snapshot) throw new AccessError('PREPARATION_SNAPSHOT_REQUIRED', 409, 'The immutable prepared fixture snapshot is unavailable.');
      assertCanManageTeam(principal, this.memberships(), teamId, snapshot.seasonId, this.now());
      const config = fixtureMatchConfig(state, snapshot);
      const existing = this.database.prepare('SELECT * FROM matches WHERE id=?').get(config.matchId) as MatchRow | undefined;
      if (!existing) this.insertMatch(config, teamId, snapshot.seasonId);
      else {
        if (existing.team_id !== teamId || existing.season_id !== snapshot.seasonId) throw new AccessError('MATCH_SCOPE_CONFLICT', 409, 'That fixture identity already belongs to another match scope.');
        if (canonical(JSON.parse(existing.config_json)) !== canonical(config)) {
          const matchState = JSON.parse(existing.state_json) as MatchState;
          const claimed = this.database.prepare('SELECT match_id FROM controller_grants WHERE match_id=?').get(config.matchId);
          const history = this.database.prepare('SELECT event_id FROM events WHERE match_id=? LIMIT 1').get(config.matchId);
          if (claimed || history || matchState.revision !== 0 || matchState.status !== 'preparation') throw new AccessError('MATCH_HISTORY_EXISTS', 409, 'This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.');
          this.database.prepare('UPDATE matches SET config_json=?,state_json=? WHERE id=?').run(JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId);
        }
      }
    }
    if (command.type.startsWith('training.') || command.type.startsWith('profile.') || command.type === 'roster.imported') this.projectPreparationRecords(teamId, seasonId, state, command.id);
    this.saveDocument(teamId, seasonId, 'preparation', state);
    this.audit(principal, command.type, teamId, 'accepted');
    if(command.type==='fixture.saved')this.enqueueNotifications(teamId,seasonId,'schedule',command.fixture.id,command.id);
    else if(command.type==='fixture.status_changed'||command.type==='fixture.selection_saved')this.enqueueNotifications(teamId,seasonId,'schedule',command.fixtureId,command.id);
    else if(command.type==='training.saved')this.enqueueNotifications(teamId,seasonId,'schedule',command.training.id,command.id);
    else if(command.type==='training.status_changed')this.enqueueNotifications(teamId,seasonId,'schedule',command.trainingId,command.id);
    else if(command.type==='training.series_created')for(const occurrence of command.occurrences)this.enqueueNotifications(teamId,seasonId,'schedule',occurrence.id,command.id);
    else if(command.type==='training.series_updated'||command.type==='training.series_cancelled')for(const id of command.occurrenceIds)this.enqueueNotifications(teamId,seasonId,'schedule',id,command.id);
    return state;
  }
  ownPreparation(principal: Principal, teamId: string, seasonId: string): Record<string, unknown> {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ['player'], this.now());
    const state = this.document<PreparationState>(teamId, seasonId, 'preparation');
    const profiles = state.profiles.filter(profile => profile.playerId === membership.playerId && profile.seasonId === seasonId && profile.active);
    if (profiles.length !== 1) throw new AccessError('NOT_FOUND', 404, 'The requested own-player profile is unavailable.');
    const profile = profiles[0];
    return { kind: 'player-preparation', revision: state.revision, team: { id: state.team.id, name: state.team.name, ageGroup: state.team.ageGroup }, season: state.seasons.find(season => season.id === seasonId), profile,
      fixtures: state.fixtures.filter(fixture => fixture.seasonId === seasonId).map(fixture => ({ id: fixture.id, opponent: fixture.opponent, playedDate: fixture.playedDate, kickoff: fixture.kickoff, venue: fixture.venue, homeAway: fixture.homeAway, status: fixture.status, response: fixture.responses[profile.id] ?? 'no_reply', selected: fixture.selectedProfileIds.includes(profile.id), attendance: fixture.attendance[profile.id] ?? 'not_recorded' })),
      training: state.training.filter(session => session.seasonId === seasonId).map(session => ({ id: session.id, date: session.date, time: session.time, venue: session.venue, status: session.status, expected: session.expectedProfileIds.includes(profile.id), response: session.responses[profile.id] ?? 'no_reply', attendance: session.attendance[profile.id] ?? 'not_recorded' })) };
  }
  ownPreparationCommand(principal: Principal, teamId: string, seasonId: string, command: OwnPreparationCommand): Record<string, unknown> {
    const membership = assertTeamRole(principal, this.memberships(), teamId, seasonId, ['player'], this.now());
    if (!command || !validId(command.id) || !nonnegative(command.expectedRevision) || !['own.preferences_saved', 'own.fixture_response_recorded', 'own.training_response_recorded'].includes(command.type)) bad('A valid own-player command and source revision are required.');
    const allowed = command.type === 'own.preferences_saved' ? ['id', 'expectedRevision', 'type', 'preferences'] : command.type === 'own.fixture_response_recorded' ? ['id', 'expectedRevision', 'type', 'fixtureId', 'response'] : ['id', 'expectedRevision', 'type', 'trainingId', 'response'];
    if (Object.keys(command).some(key => !allowed.includes(key))) bad('Own-player commands cannot change another profile or manager-controlled fields.');
    const state = this.document<PreparationState>(teamId, seasonId, 'preparation');
    const profiles = state.profiles.filter(profile => profile.playerId === membership.playerId && profile.seasonId === seasonId && profile.active);
    if (profiles.length !== 1) throw new AccessError('NOT_FOUND', 404, 'The requested own-player profile is unavailable.');
    const profile = profiles[0];
    const base = { id: command.id, expectedRevision: command.expectedRevision };
    const bound: PreparationCommand = command.type === 'own.preferences_saved' ? { ...base, type: 'profile.saved', profile: { ...profile, preferences: command.preferences } }
      : command.type === 'own.fixture_response_recorded' ? { ...base, type: 'fixture.response_recorded', fixtureId: command.fixtureId, profileId: profile.id, response: command.response }
      : { ...base, type: 'training.response_recorded', trainingId: command.trainingId, profileId: profile.id, response: command.response };
    const updated = reducePreparation(state, bound);
    if (bound.type.startsWith('training.') || bound.type.startsWith('profile.')) this.projectPreparationRecords(teamId, seasonId, updated, command.id);
    this.saveDocument(teamId, seasonId, 'preparation', updated);
    this.audit(principal, command.type, teamId, 'accepted');
    return this.ownPreparation(principal, teamId, seasonId);
  }
  /** SQL account/membership records remain the authority; the serializable model is a projection. */
  communityState(teamId: string, seasonId: string): CommunityState {
    const state = this.document<CommunityState>(teamId, seasonId, 'community');
    const accounts = this.database.prepare("SELECT * FROM accounts WHERE status='active'").all() as unknown as AccountRow[];
    const memberships = this.memberships();
    return { ...state,
      accounts: accounts.map(account => ({ id: account.id, label: state.accounts.find(person => person.id === account.id)?.label ?? 'Verified account', classification: account.classification === 'unclassified' ? 'spectator' : account.classification, adultVerified: !!account.adult_verified })),
      memberships: memberships.filter(item => item.role === 'manager' || item.role === 'player').map(item => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role as 'manager' | 'player', playerId: item.playerId, active: item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()) })),
    };
  }
  communityActor(principal: Principal, teamId: string, seasonId: string, requestedRole?: string, invitationAcceptance = false): CommunityActor {
    const memberships = this.memberships();
    if (invitationAcceptance) return { accountId: principal.accountId, teamId, seasonId, role: 'spectator' };
    const allowed = currentMemberships(principal, memberships, this.now()).filter(item => item.teamId === teamId && item.seasonId === seasonId && ['manager', 'player', 'spectator'].includes(item.role));
    const chosen = requestedRole ? allowed.find(item => item.role === requestedRole) : allowed.find(item => item.role === 'manager') ?? allowed[0];
    if (!chosen) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    if (chosen.role === 'manager') assertAdultAuthority(principal, false, this.now());
    const actor = { accountId: principal.accountId, teamId, seasonId, role: chosen.role as CommunityActor['role'], playerId: chosen.playerId };
    const document = this.database.prepare("SELECT team_id FROM documents WHERE team_id=? AND season_id=? AND kind='community'").get(teamId, seasonId);
    if (document && !communityCanAccess(this.communityState(teamId, seasonId), actor, this.now())) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return actor;
  }
  community(principal: Principal, teamId: string, seasonId: string, role?: string): ReturnType<typeof getCommunityView> & { revision: number } {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    const state = this.communityState(teamId, seasonId);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  communityCommand(principal: Principal, teamId: string, seasonId: string, command: CommunityCommand, role?: string): ReturnType<typeof getCommunityView> & { revision: number } {
    if (!command || !validId(command.id) || typeof command.type !== 'string') bad('A typed community command with a stable identity is required.');
    if (command.type === 'concern.updated' && !['under_review', 'resolved'].includes(command.status)) bad('Invalid concern status.');
    if (command.type === 'concern.submitted' && (!['photo', 'uploader'].includes(command.targetType) || !['privacy', 'inappropriate', 'other'].includes(command.category))) bad('Invalid concern category.');
    if (command.type === 'uploader.hidden' && typeof command.hidden !== 'boolean') bad('Choose whether to hide the uploader.');
    if (command.type === 'privacy.drafted' && !['export', 'delete_global_account'].includes(command.requestType)) bad('Invalid privacy request type.');
    if (command.type === 'match.registered') throw new AccessError('POLICY_APPROVAL_REQUIRED', 503, 'Connected award and sharing context must be derived from accepted match evidence, a verified finish-time anchor and independently approved competition policy. Caller-supplied trusted finish or sharing policy is not accepted.');
    const actor = this.communityActor(principal, teamId, seasonId, role, command.type === 'invite.accepted');
    const previous = this.communityState(teamId, seasonId);
    const state = applyCommunityCommand(previous, actor, command, this.now());
    this.saveDocument(teamId, seasonId, 'community', state);
    if (['invite.accepted', 'invite.revoked', 'grant.revoked'].includes(command.type)) this.synchronizeSpectatorMemberships(state);
    // Only an explicitly configured cutoff creates a job; Q15's +59 proposal is never silently selected.
    for (const match of state.matches.filter(match => match.voteCutoffAtMs !== null && match.finishQuality === 'trusted' && !state.awards.some(award => award.matchId === match.id))) {
      const key = `award:${teamId}:${seasonId}:${match.id}:${match.voteCutoffAtMs}`;
      this.database.prepare('INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,?,?,?) ON CONFLICT(business_key) DO NOTHING').run(randomUUID(), key, 'award.finalise', JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs!);
    }
    this.audit(principal, command.type, teamId, 'accepted');
    if(command.type==='photo.submitted'||command.type==='photo.revised'||command.type==='photo.published'||command.type==='photo.reviewed'&&command.decision==='approve')this.enqueueNotifications(teamId,seasonId,'photos',command.photoId,command.id);
    if(command.type==='award.finalised')this.enqueueNotifications(teamId,seasonId,'awards',command.matchId,command.id);
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
  }
  synchronizeSpectatorMemberships(state: CommunityState): void {
    const scopes = new Map<string, { accountId: string; teamId: string; seasonId: string }>();
    for (const grant of state.grants) scopes.set(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]), { accountId: grant.accountId, teamId: grant.teamId, seasonId: grant.seasonId });
    for (const scope of scopes.values()) {
      const grants = state.grants.filter(grant => grant.accountId === scope.accountId && grant.teamId === scope.teamId && grant.seasonId === scope.seasonId);
      const active = grants.filter(grant => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
      // A union of grants survives one revocation. Never let insertion order decide authority.
      const expiresAt = Math.max(...(active.length ? active : grants).map(grant => grant.expiresAtMs));
      const revokedAt = active.length ? null : Math.max(1, this.now());
      this.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role,expires_at,revoked_at) VALUES(?,?,?,'spectator',?,?) ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=excluded.revoked_at").run(scope.accountId, scope.teamId, scope.seasonId, expiresAt, revokedAt);
    }
  }
  media(principal: Principal, teamId: string, seasonId: string, photoId: string, mode: 'gallery' | 'own' | 'review', role?: string): ReturnType<typeof authorizeCommunityMedia> {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    const result = authorizeCommunityMedia(this.communityState(teamId, seasonId), actor, photoId, this.now(), mode);
    if (!result.allowed) throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return result;
  }
  recordsViewer(principal: Principal, teamId: string, seasonId: string, role?: string): RecordsViewer {
    const actor = this.communityActor(principal, teamId, seasonId, role);
    return { actor: actor.role, playerId: actor.playerId, teamId, seasonId };
  }
  private recordsContext(principal: Principal, teamId: string, seasonId: string, role?: string): RecordsServiceInput {
    const viewer = this.recordsViewer(principal, teamId, seasonId, role);
    const rows = this.database.prepare('SELECT state_json FROM matches WHERE team_id=? AND season_id=? ORDER BY id').all(teamId, seasonId) as { state_json: string }[];
    const community=this.communityState(teamId,seasonId);
    const actor=this.communityActor(principal,teamId,seasonId,viewer.actor);
    const filtered=getCommunityView(community,actor,this.now());
    return { principal, memberships: this.memberships(), nowMs: this.now(), requestedRole: viewer.actor, state: this.document<RecordsState>(teamId, seasonId, 'records'), acceptedMatches: rows.map(row => ({ teamId, seasonId, match: JSON.parse(row.state_json) as MatchState })),community:{accountId:principal.accountId,teamId,seasonId,audience:viewer.actor,playerId:viewer.playerId??null,revision:community.revision,view:{allowed:filtered.allowed,matches:filtered.matches,gallery:filtered.gallery}} };
  }
  records(principal: Principal, teamId: string, seasonId: string, role?: string): Record<string, unknown> { return recordsServiceView(this.recordsContext(principal, teamId, seasonId, role)); }
  recordsExport(principal: Principal, teamId: string, seasonId: string, request: RecordsExportRequest, role?: string): ReturnType<typeof recordsServiceExport> { return recordsServiceExport({ ...this.recordsContext(principal, teamId, seasonId, role), request }); }
  recordsCommand(principal: Principal, teamId: string, seasonId: string, command: RecordsServiceCommand, role?: string): Record<string, unknown> {
    const state = applyRecordsServiceCommand({ ...this.recordsContext(principal, teamId, seasonId, role), command });
    this.saveDocument(teamId, seasonId, 'records', state);
    this.audit(principal, command.type, teamId, 'accepted');
    return this.records(principal, teamId, seasonId, 'manager');
  }
}
