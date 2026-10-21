import { PgDatabase, type PgApplicationContext } from './pg';
import type { DatabaseRequestScope } from './request-context';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { managerRoster as projectManagerRoster, type StaffAccountEvidence } from '../../../packages/application/src/staff';
import { prepareAccountPrivacyRequest, projectAccountPrivacyRequests, type PrivacyRequestRecord } from '../../../packages/application/src/privacy-requests';

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
}/** Real PostgreSQL repository: explicit SQL, shared reducers, pinned async transactions. */
export class PostgresStore {
 constructor(readonly db:PgDatabase,readonly now:()=>number=Date.now){}
static async open(connectionString: string, now: () => number = Date.now, options: {
    migrationMode?: 'apply' | 'verify';
} = {}): Promise<PostgresStore> {
    const db = new PgDatabase(connectionString, options);
    try {
        await db.migrate();
        return new PostgresStore(db, now);
    }
    catch (error) {
        await db.close();
        throw error;
    }
}
 async close():Promise<void>{await this.db.close();}
 async assertRuntimeRole(kind:'api'|'worker'):Promise<void>{
   const role=await this.one(`SELECT r.rolsuper,r.rolbypassrls,longball.runtime_purpose() AS runtime_purpose,
     EXISTS(SELECT 1 FROM pg_catalog.pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolbypassrls) AND pg_has_role(current_user,privileged.oid,'MEMBER')) AS privileged_membership,
     (EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='longball' AND pg_has_role(current_user,n.nspowner,'MEMBER')) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='longball' AND c.relkind IN('r','p') AND pg_has_role(current_user,c.relowner,'MEMBER'))) AS owns_data
     FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
   if(!role||role.rolsuper||role.rolbypassrls||role.privileged_membership||role.owns_data)throw new Error(`The PostgreSQL ${kind} requires a separate non-owner role without superuser, bypass-RLS or privileged-role membership.`);
   if(role.runtime_purpose!==kind)throw new Error(`The PostgreSQL role is not assigned the ${kind} runtime purpose.`);
 }
 transaction<T>(work:()=>Promise<T>|T):Promise<T>{return this.db.transaction(work);}
 async withIdentityContext<T>(identity:VerifiedIdentity,work:()=>Promise<T>|T):Promise<T>{
   return this.db.withContext({kind:'identity',issuer:identity.issuer,subject:identity.subject,nowMs:this.now()},work);
 }
 async withActorContext<T>(principal:Principal,scope:DatabaseRequestScope,work:()=>Promise<T>|T):Promise<T>{
   const context:Extract<PgApplicationContext,{kind:'actor'}>={kind:'actor',accountId:principal.accountId,issuer:principal.issuer,subject:principal.subject,strongAuth:principal.strongAuth,authenticatedAtMs:principal.authenticatedAt,nowMs:this.now(),...scope};
   return this.db.withContext(context,async()=>{
     if(scope.matchId){
       const match=await this.one('SELECT club_id,team_id,season_id FROM matches WHERE id=$1',[scope.matchId]);
       if(!match||typeof match.club_id!=='string'||typeof match.team_id!=='string'||typeof match.season_id!=='string')throw new AccessError('NOT_FOUND',404,'The requested object is unavailable.');
       return this.db.withContext({...context,clubId:String(match.club_id),teamId:String(match.team_id),seasonId:String(match.season_id)},work);
     }
     if(scope.teamId){
       const team=await this.one("SELECT club_id FROM teams WHERE id=$1 AND scope_status='resolved'",[scope.teamId]);
       if(!team||typeof team.club_id!=='string')throw new AccessError('NOT_FOUND',404,'The requested object is unavailable.');
       return this.db.withContext({...context,clubId:String(team.club_id)},work);
     }
     return work();
   });
 }
 async one(sql:string,values:readonly unknown[]=[]):Promise<Record<string,unknown>|undefined>{return (await this.db.query(sql,values)).rows[0];}
 async many(sql:string,values:readonly unknown[]=[]):Promise<Record<string,unknown>[]>{return (await this.db.query(sql,values)).rows;}
 async execute(sql:string,values:readonly unknown[]=[]):Promise<{changes:number}>{return {changes:(await this.db.query(sql,values)).rowCount??0};}
async seedSynthetic(): Promise<void> {
    (await this.transaction(async () => {
        if ((await this.one("SELECT id FROM teams LIMIT 1", [])))
            return;
        await this.execute('INSERT INTO clubs(id,name) VALUES($1,$2),($3,$4)',['synthetic-richmond-rovers','Richmond Rovers · fictional','synthetic-other-club','Other fictional club']);
        (await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", [SYNTHETIC_IDS.teamId, 'Roma U10 · fictional','synthetic-richmond-rovers']));
        (await this.execute("INSERT INTO teams(id,name,club_id,scope_status) VALUES($1,$2,$3,'resolved')", ['synthetic-other-team', 'Other fictional team','synthetic-other-club']));
        await this.execute('INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7),($8,$9,$3,$4,$5,$6,$7)',['synthetic-richmond-rovers',SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'2026/27',2026,'2026-09-01','2027-08-31','synthetic-other-club','synthetic-other-team']);
        const add = async (id: string, classification: Principal['identityClassification'], adult: boolean) => (await this.execute("INSERT INTO accounts(id,issuer,subject,classification,adult_verified,strong_auth_enrolled) VALUES($1,$2,$3,$4,$5,$6)", [id, 'urn:longball:synthetic', id, classification, Number(adult), Number(adult)]));
        const membership = async (id: string, role: string, playerId: string | null = null, teamId: string = SYNTHETIC_IDS.teamId) => (await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES($1,$2,$3,$4,$5)", [id, teamId, SYNTHETIC_IDS.seasonId, role, playerId]));
        (await add('synthetic-account-admin', 'adult_individual', true));
        (await membership('synthetic-account-admin', 'administrator'));
        for (let number = 1; number <= 5; number++) {
            const id = number === 1 ? 'synthetic-account-manager' : `synthetic-account-manager-${number}`;
            (await add(id, 'adult_individual', true));
            if (number <= 4)
                (await membership(id, 'manager'));
            if (number === 1)
                (await membership(id, 'administrator'));
        }
        for (let number = 1; number <= 13; number++) {
            const suffix = String(number).padStart(2, '0');
            const id = `synthetic-account-player-${suffix}`;
            (await add(id, 'child_shared', false));
            (await membership(id, 'player', `synthetic-player-${suffix}`));
        }
        (await add('synthetic-account-spectator', 'adult_individual', false));
        (await membership('synthetic-account-spectator', 'spectator'));
        (await add('synthetic-account-invitee', 'adult_individual', false));
        (await add('synthetic-account-other-manager', 'adult_individual', true));
        (await membership('synthetic-account-other-manager', 'manager', null, 'synthetic-other-team'));
        const config: MatchConfig = { matchId: SYNTHETIC_IDS.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.filter(player => player.available).map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1500000, fixedKeeperId: romaFixture.players[0].id };
        (await this.insertMatch(config, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId));
        const community = createCommunityState(this.now());
        community.matches = community.matches.map(match => ({ ...match, sharing: 'manager_only' }));
        for (let number = 2; number <= 4; number++) {
            const id = `synthetic-account-manager-${number}`;
            community.accounts.push({ id, label: `Fictional manager ${number}`, classification: 'adult_individual', adultVerified: true });
            community.memberships.push({ accountId: id, teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, role: 'manager', active: true });
        }
        (await this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation', createPreparationState()));
        (await this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', community));
        (await this.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'records', createRecordsSeed()));
    }));
}
async insertMatch(config: MatchConfig, teamId: string, seasonId: string): Promise<void> {
    (await this.execute("INSERT INTO matches(id,team_id,season_id,config_json,state_json,sharing_policy_json) VALUES($1,$2,$3,$4,$5,$6)", [config.matchId, teamId, seasonId, JSON.stringify(config), JSON.stringify(createMatch(config)), JSON.stringify(UNAPPROVED_SHARING_POLICY)]));
}
async principal(identity: VerifiedIdentity): Promise<Principal> {
    const account = (await this.one("SELECT * FROM accounts WHERE issuer=$1 AND subject=$2", [identity.issuer, identity.subject])) as AccountRow | undefined;
    if (!account || account.status !== 'active')
        throw new AccessError('ACCOUNT_UNAVAILABLE', 403, 'The account is not active for this service.');
    return { accountId: account.id, issuer: account.issuer, subject: account.subject, identityClassification: account.classification, adultVerified: Boolean(account.adult_verified), strongAuth: identity.strongAuth, authenticatedAt: identity.authenticatedAt, status: account.status };
}
async memberships(): Promise<Membership[]> {
    const rows=await this.many("SELECT m.*,CASE WHEN m.role='spectator' THEN longball.spectator_grant_active(m.account_id,m.club_id,m.team_id,m.season_id) ELSE true END AS grant_active FROM memberships m") as unknown as {account_id:string;team_id:string;season_id:string;role:Membership['role'];player_id:string|null;expires_at:number|null;revoked_at:number|null;grant_active:boolean}[];
    return rows.map(row=>({accountId:row.account_id,teamId:row.team_id,seasonId:row.season_id,role:row.role,playerId:row.player_id??undefined,expiresAt:row.expires_at,revokedAt:row.role==='spectator'&&!row.grant_active?row.revoked_at??Math.max(1,this.now()):row.revoked_at}));
}
async myMemberships(principal: Principal): Promise<Membership[]> { return currentMemberships(principal, (await this.memberships()), this.now()); }
async match(matchId: string): Promise<MatchRow> {
    const row = (await this.one("SELECT * FROM matches WHERE id=$1", [matchId])) as MatchRow | undefined;
    if (!row)
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return row;
}
async managerMatch(principal: Principal, matchId: string): Promise<MatchRow> {
    const row = (await this.match(matchId));
    assertCanManageTeam(principal, (await this.memberships()), row.team_id, row.season_id, this.now());
    return row;
}
async matchDto(principal: Principal, matchId: string, requestedRole?: string): Promise<Record<string, unknown>> {
    const row = (await this.match(matchId));
    return filterMatchForPrincipal({ principal, memberships: (await this.memberships()), teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json) as MatchState, policy: JSON.parse(row.sharing_policy_json) as SharingPolicy, lastSyncAt: row.last_sync_at, now: this.now(), requestedRole });
}
async download(principal: Principal, matchId: string, deviceId: string): Promise<Record<string, unknown>> {
    const row = (await this.managerMatch(principal, matchId));
    if (!validDeviceId(deviceId))
        bad('A device identifier of at most 120 canonical characters is required.');
    const stream = (await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, deviceId])) as StreamRow | undefined;
    const grant = (await this.one("SELECT epoch,account_id,device_id,frozen FROM controller_grants WHERE match_id=$1", [matchId]));
    return { contractVersion: EVENT_CONTRACT_VERSION, schemaVersion: 1, engineVersion: ENGINE_VERSION, matchId, teamId: row.team_id, seasonId: row.season_id, state: JSON.parse(row.state_json), acceptedRevision: (JSON.parse(row.state_json) as MatchState).revision, deviceCheckpoint: { clientSequence: stream?.sequence ?? 0, previousEventId: stream?.previous_event_id ?? null }, controller: grant ?? null, downloadedAt: new Date(this.now()).toISOString(), clockAnchor: { serverTime: new Date(this.now()).toISOString(), quality: 'observation_only', continuousMappingEstablished: false } };
}
async audit(principal: Principal, action: string, objectId: string, outcome: string): Promise<void> {
    (await this.execute("INSERT INTO audit(id,actor_id,action,object_id,outcome,created_at) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), principal.accountId, action, objectId, outcome, this.now()]));
}
async idempotent<T>(principal: Principal, operation: string, key: string, payload: unknown, work: () => T | Promise<T>): Promise<T> {
    if (!validId(key) || key.length < 8)
        bad('A stable Idempotency-Key is required for mutations.');
    const signature = digest(canonical(payload));
    return (await this.transaction(async () => {
        const prior = (await this.one("SELECT signature,response_json FROM idempotency WHERE account_id=$1 AND operation=$2 AND key=$3", [principal.accountId, operation, key])) as {
            signature: string;
            response_json: string;
        } | undefined;
        if (prior) {
            if (prior.signature !== signature)
                throw new AccessError('IDEMPOTENCY_CONFLICT', 409, 'The idempotency key was already used with different content.');
            return JSON.parse(prior.response_json) as T;
        }
        const response = (await work());
        (await this.execute("INSERT INTO idempotency(account_id,operation,key,signature,response_json) VALUES($1,$2,$3,$4,$5)", [principal.accountId, operation, key, signature, JSON.stringify(response)]));
        return response;
    }));
}
async acquire(principal: Principal, matchId: string, deviceId: string): Promise<Record<string, unknown>> {
    (await this.managerMatch(principal, matchId));
    if (!validDeviceId(deviceId))
        bad('A device identifier of at most 120 canonical characters is required.');
    const prior = (await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId])) as GrantRow | undefined;
    if (prior)
        throw new AccessError('CONTROLLER_EXISTS', 409, 'This match already has a controller. Use handover or audited recovery.');
    (await this.bindDevice(principal, deviceId));
    const token = randomBytes(32).toString('base64url');
    (await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES($1,$2,$3,$4,$5)", [matchId, 1, principal.accountId, deviceId, digest(token)]));
    (await this.audit(principal, 'controller.acquired', matchId, 'accepted'));
    return { epoch: 1, deviceId, controllerToken: token, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint };
}
async assertController(principal: Principal, matchId: string, token: string | undefined): Promise<GrantRow> {
    (await this.managerMatch(principal, matchId));
    const grant = (await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId])) as GrantRow | undefined;
    if (!grant || grant.account_id !== principal.accountId || !token || digest(token) !== grant.capability_hash)
        throw new AccessError('CONTROLLER_REQUIRED', 409, 'Only the selected manager and enrolled device may write this match.');
    return grant;
}
async issueClockChallenge(principal: Principal, matchId: string, token: string | undefined, input: {
    deviceId: string;
    controllerEpoch: number;
    continuityId: string;
}, policy: TrustedTimePolicy | undefined): Promise<ClockChallenge> {
    const grant = (await this.assertController(principal, matchId, token));
    if (!policy)
        throw new AccessError('CLOCK_POLICY_REQUIRED', 503, 'An explicitly configured trusted-time policy is required before establishing an anchor.');
    if (!input || Object.keys(input).some(key => !['deviceId', 'controllerEpoch', 'continuityId'].includes(key)) || !validDeviceId(input.deviceId) || !validId(input.continuityId) || input.deviceId !== grant.device_id || input.controllerEpoch !== grant.epoch || grant.frozen)
        throw new AccessError('CLOCK_SCOPE_CONFLICT', 409, 'Use the current unfrozen controller device, epoch and continuous-clock identity.');
    const challenge = makeClockChallenge({ accountId: principal.accountId, deviceId: grant.device_id, matchId, controllerEpoch: grant.epoch, continuityId: input.continuityId }, randomUUID(), this.now(), policy);
    (await this.execute("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES($1,$2,$3,$4)", [challenge.id, matchId, principal.accountId, JSON.stringify(challenge)]));
    return challenge;
}
async acknowledgeClockChallenge(principal: Principal, matchId: string, token: string | undefined, challengeId: string, sample: {
    receivedMonotonicMs: number;
    sentMonotonicMs: number;
}, policy: TrustedTimePolicy | undefined): Promise<ContinuousUtcMapping> {
    const grant = (await this.assertController(principal, matchId, token));
    if (!policy)
        throw new AccessError('CLOCK_POLICY_REQUIRED', 503, 'An explicitly configured trusted-time policy is required before establishing an anchor.');
    if (!sample || Object.keys(sample).some(key => !['receivedMonotonicMs', 'sentMonotonicMs'].includes(key)))
        bad('Use the documented continuous-clock receipt and send observations.');
    const row = (await this.one("SELECT challenge_json,consumed_at FROM clock_challenges WHERE id=$1 AND match_id=$2 AND account_id=$3", [challengeId, matchId, principal.accountId])) as {
        challenge_json: string;
        consumed_at: number | null;
    } | undefined;
    if (!row)
        throw new AccessError('NOT_FOUND', 404, 'That challenge is unavailable.');
    const challenge = JSON.parse(row.challenge_json) as ClockChallenge;
    if (row.consumed_at !== null)
        throw new AccessError('CLOCK_CHALLENGE_CONSUMED', 409, 'That clock exchange was consumed. Retrying the same request key returns its receipt.');
    if (challenge.controllerEpoch !== grant.epoch || challenge.deviceId !== grant.device_id || grant.frozen)
        throw new AccessError('CLOCK_SCOPE_CONFLICT', 409, 'The controller changed before the clock exchange completed.');
    let mapping: ContinuousUtcMapping;
    try {
        mapping = acceptClockChallenge(challenge, sample, this.now(), policy);
    }
    catch {
        throw new AccessError('CLOCK_EXCHANGE_REJECTED', 422, 'The clock exchange expired or its evidence exceeds the configured uncertainty bounds.');
    }
    (await this.execute("UPDATE clock_challenges SET consumed_at=$1 WHERE id=$2 AND consumed_at IS NULL", [this.now(), challengeId]));
    (await this.execute("INSERT INTO clock_mappings(challenge_id,match_id,mapping_json,created_at) VALUES($1,$2,$3,$4)", [challengeId, matchId, JSON.stringify(mapping), this.now()]));
    (await this.audit(principal, 'clock.mapping_established', matchId, policy.id));
    return mapping;
}
async reconciliation(principal: Principal, matchId: string): Promise<ReconciliationSnapshot> {
    const row = (await this.managerMatch(principal, matchId));
    const state = JSON.parse(row.state_json) as MatchState;
    const events = (await this.many("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=$1 AND disposition='quarantined' ORDER BY received_at,client_sequence", [matchId])) as {
        event_id: string;
        device_id: string;
        client_sequence: number;
        envelope_json: string;
        reason: string;
        received_at: number;
    }[];
    const conflicts = (await this.many("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=$1 ORDER BY created_at,id", [matchId])) as {
        id: string;
        original_json: string;
        reason: string;
        created_at: number;
    }[];
    const submissions: ReconciliationSubmission[] = [...events.map(event => { const original = JSON.parse(event.envelope_json) as EventEnvelope; return { submissionId: event.event_id, matchId, eventId: event.event_id, deviceId: event.device_id, clientSequence: event.client_sequence, controllerEpoch: original.controllerEpoch ?? null, reason: event.reason, original, originalDigest: digest(canonical(original)), receivedAt: new Date(event.received_at).toISOString() }; }), ...conflicts.map(conflict => { const original = JSON.parse(conflict.original_json) as Partial<EventEnvelope>; return { submissionId: conflict.id, matchId, eventId: typeof original.eventId === 'string' ? original.eventId : null, deviceId: typeof original.deviceId === 'string' ? original.deviceId : null, clientSequence: typeof original.clientSequence === 'number' ? original.clientSequence : null, controllerEpoch: typeof original.controllerEpoch === 'number' ? original.controllerEpoch : null, reason: conflict.reason, original, originalDigest: digest(canonical(original)), receivedAt: new Date(conflict.created_at).toISOString() }; })];
    const proposals = ((await this.many("SELECT receipt_json FROM reconciliation_proposals WHERE match_id=$1 ORDER BY created_at,id", [matchId])) as {
        receipt_json: string;
    }[]).map(item => JSON.parse(item.receipt_json) as ReconciliationProposal);
    return { matchId, acceptedRevision: state.revision, submissions, proposals, policy: Q08_RECONCILIATION_POLICY };
}
async proposeReconciliation(principal: Principal, matchId: string, input: ReconciliationProposalInput): Promise<ReconciliationProposal> {
    const row = (await this.managerMatch(principal, matchId));
    const state = JSON.parse(row.state_json) as MatchState;
    if (!input || Object.keys(input).some(key => !['proposalId', 'baseRevision', 'sourceSubmissionIds', 'reason', 'resolution', 'commands'].includes(key)))
        bad('Use only the documented immutable reconciliation proposal fields.');
    const signature = digest(canonical(input));
    const existing = (await this.one("SELECT signature,receipt_json FROM reconciliation_proposals WHERE id=$1 AND match_id=$2 AND actor_id=$3", [input.proposalId, matchId, principal.accountId])) as {
        signature: string;
        receipt_json: string;
    } | undefined;
    if (existing) {
        if (existing.signature !== signature)
            throw new AccessError('RECONCILIATION_PROPOSAL_CONFLICT', 409, 'That proposal identity already preserves different review evidence.');
        return JSON.parse(existing.receipt_json) as ReconciliationProposal;
    }
    const snapshot = (await this.reconciliation(principal, matchId));
    const preview = previewReconciliation(state, input, snapshot.submissions, { actorId: principal.accountId, recordedAtMs: this.now() });
    if (!preview.valid)
        throw new AccessError('RECONCILIATION_PREVIEW_REJECTED', 422, preview.issues.join(' ').slice(0, 1500));
    const { projectedState: discarded, ...savedPreview } = preview;
    void discarded;
    const receipt: ReconciliationProposal = { input, matchId, actorId: principal.accountId, createdAt: new Date(this.now()).toISOString(), sourceDigests: input.sourceSubmissionIds.map(id => ({ submissionId: id, originalDigest: snapshot.submissions.find(item => item.submissionId === id)!.originalDigest })), acceptedStateDigest: digest(canonical(state)), preview: savedPreview, status: 'prepared', appliedRevision: null };
    (await this.execute("INSERT INTO reconciliation_proposals(id,match_id,actor_id,signature,receipt_json,created_at) VALUES($1,$2,$3,$4,$5,$6)", [input.proposalId, matchId, principal.accountId, signature, JSON.stringify(receipt), this.now()]));
    (await this.audit(principal, 'reconciliation.proposal_prepared', matchId, 'q08_authority_unapproved'));
    return receipt;
}
async recordFinishedContext(principal: Principal, matchId: string, policy: TrustedTimePolicy | undefined): Promise<{
    status: string;
    finishQuality?: string;
}> {
    const row = (await this.managerMatch(principal, matchId));
    const state = JSON.parse(row.state_json) as MatchState;
    if (state.status !== 'completed')
        return { status: 'not_finished' };
    (await this.refreshDetailedArchive(row, state));
    const community = (await this.communityState(row.team_id, row.season_id));
    const existing = community.matches.find(item => item.id === matchId);
    const quarantine = (await this.one("SELECT event_id FROM events WHERE match_id=$1 AND disposition='quarantined' LIMIT 1", [matchId]));
    const conflict = (await this.one("SELECT id FROM conflicting_submissions WHERE match_id=$1 LIMIT 1", [matchId]));
    const unresolved = Boolean(quarantine || conflict);
    if (existing) {
        const retainedFinishId = state.eventHistory?.filter(event => event.type === 'half.ended').at(-1)?.id;
        const retainedFinish = retainedFinishId ? (await this.one("SELECT envelope_json FROM events WHERE event_id=$1 AND match_id=$2 AND disposition='accepted'", [retainedFinishId, matchId])) as {
            envelope_json: string;
        } | undefined : undefined;
        const currentGrant = (await this.one("SELECT epoch FROM controller_grants WHERE match_id=$1", [matchId])) as {
            epoch: number;
        } | undefined;
        const sourceEpoch = retainedFinish ? (JSON.parse(retainedFinish.envelope_json) as EventEnvelope).controllerEpoch : null;
        const quality = unresolved ? 'conflicted' : state.recoveryRequired || sourceEpoch !== currentGrant?.epoch || finishEligibilityChanged(state, existing) ? 'review_required' : existing.finishQuality;
        if (quality !== existing.finishQuality) {
            const next: CommunityState = { ...community, revision: community.revision + 1, matches: community.matches.map(match => match.id === matchId ? { ...match, finishQuality: quality } : match), audit: [...community.audit, { id: randomUUID(), actorAccountId: null, action: 'service.finish_evidence_flagged_without_reopening', atMs: this.now() }] };
            (await this.saveDocument(row.team_id, row.season_id, 'community', next));
        }
        return { status: 'original_context_preserved', finishQuality: quality };
    }
    const finishId = state.eventHistory?.filter(event => event.type === 'half.ended').at(-1)?.id;
    const finishRow = finishId ? (await this.one("SELECT envelope_json,actor_id FROM events WHERE event_id=$1 AND match_id=$2 AND disposition='accepted'", [finishId, matchId])) as {
        envelope_json: string;
        actor_id: string | null;
    } | undefined : undefined;
    const finish = finishRow ? JSON.parse(finishRow.envelope_json) as EventEnvelope : null;
    const mappingRow = finish ? (await this.one("SELECT mapping_json FROM clock_mappings WHERE challenge_id=$1 AND match_id=$2", [finish.clockEvidence.anchorId, matchId])) as {
        mapping_json: string;
    } | undefined : undefined;
    const grant = (await this.one("SELECT epoch FROM controller_grants WHERE match_id=$1", [matchId])) as {
        epoch: number;
    } | undefined;
    const preparation = (await this.document<PreparationState>(row.team_id, row.season_id, 'preparation'));
    const fixture = preparation.fixtures.find(item => item.id === matchId && item.seasonId === row.season_id);
    const playedDate = state.config.fixture?.playedDate ?? fixture?.playedDate;
    if (!playedDate)
        return { status: 'accepted_fixture_date_required' };
    // A saved calendar date is a schedule sort key, never an observed kickoff or actual full time.
    const scheduledAtMs = Date.parse(`${playedDate}T00:00:00Z`);
    const context = deriveFinishedMatchContext({ state, acceptedFinish: finish, acceptedFinishActorId: finishRow?.actor_id ?? null, teamId: row.team_id, seasonId: row.season_id, currentControllerEpoch: grant?.epoch ?? 0, unresolvedConflicts: unresolved, mapping: mappingRow ? JSON.parse(mappingRow.mapping_json) as ContinuousUtcMapping : null, policy: policy ?? null, serverNowMs: this.now(), scheduledAtMs, sharing: 'manager_only', sharingPolicyVersion: 0 });
    const next: CommunityState = { ...community, revision: community.revision + 1, matches: [...community.matches, { ...context, voteCutoffAtMs: null, cutoffSource: 'unresolved', finalisationDeadlineAtMs: context.actualFullTimeAtMs === null ? null : context.actualFullTimeAtMs + 3600000 }], audit: [...community.audit, { id: randomUUID(), actorAccountId: null, action: 'service.accepted_finish_registered_manager_only', atMs: this.now() }] };
    (await this.saveDocument(row.team_id, row.season_id, 'community', next));
    return { status: 'registered_from_accepted_history', finishQuality: context.finishQuality };
}
private async refreshDetailedArchive(row: MatchRow, match: MatchState): Promise<void> {
    const saved = (await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='records'", [row.team_id, row.season_id])) as {
        value_json: string;
    } | undefined;
    if (!saved)
        return;
    const records = JSON.parse(saved.value_json) as RecordsState;
    const archived = records.results.find(item => item.id === match.config.matchId && item.recordMode === 'detailed_live');
    if (!archived || (archived.sourceMatchRevision ?? -1) >= match.revision)
        return;
    if (match.recoveryRequired) {
        if (archived.detailCompleteness !== 'review_required') {
            const reviewed: RecordsState = { ...records, revision: records.revision + 1, results: records.results.map(item => item.id === archived.id ? { ...item, detailCompleteness: 'review_required', revision: item.revision + 1 } : item) };
            (await this.saveDocument(row.team_id, row.season_id, 'records', reviewed));
        }
        return;
    }
    const context = { matchId: archived.id, playedDate: archived.playedDate, opponent: archived.opponent, homeAway: archived.homeAway, fixtureClass: archived.fixtureClass };
    const updated = reduceRecords({ ...records, liveMatch: context }, { type: 'live.archive', commandId: `accepted-archive-${digest(canonical([archived.id, match.revision]))}`, at: new Date(this.now()).toISOString(), actor: 'manager', match, reason: 'Existing detailed archive refreshed from the newer accepted canonical match revision; original source events and prior archive audit remain retained.' });
    const projected: RecordsState = { ...updated, liveMatch: records.liveMatch };
    (await this.saveDocument(row.team_id, row.season_id, 'records', projected));
}
async upload(principal: Principal, matchId: string, token: string | undefined, values: unknown[]): Promise<{
    results: UploadResult[];
    revision: number;
    pendingReview: boolean;
}> {
    const row = (await this.managerMatch(principal, matchId));
    if (!Array.isArray(values) || values.length === 0 || values.length > 100)
        bad('Upload between one and 100 ordered events.');
    const grant = (await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId])) as GrantRow | undefined;
    // An old manager's fenced branch is retained but can never affect the accepted projection.
    const currentCapability = !!grant && grant.account_id === principal.accountId && !!token && digest(token) === grant.capability_hash;
    let state = JSON.parse(row.state_json) as MatchState;
    const results: UploadResult[] = [];
    for (const value of values) {
        const event = validateEnvelope(value, matchId);
        const device = (await this.one("SELECT account_id FROM devices WHERE id=$1", [event.deviceId])) as {
            account_id: string;
        } | undefined;
        if (!device || device.account_id !== principal.accountId)
            throw new AccessError('DEVICE_BINDING_REQUIRED', 403, 'This event device is not enrolled to the authenticated account.');
        const signature = digest(canonical(event));
        const previous = (await this.one("SELECT * FROM events WHERE event_id=$1", [event.eventId])) as EventRow | undefined;
        if (previous) {
            if (previous.match_id !== matchId || previous.signature !== signature) {
                (await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), matchId, principal.accountId, JSON.stringify(value), 'EVENT_ID_CONFLICT', this.now()]));
                results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: 'quarantined', reason: 'EVENT_ID_CONFLICT', revision: null, duplicate: false });
            }
            else
                results.push({ eventId: previous.event_id, clientSequence: previous.client_sequence, disposition: previous.disposition as UploadResult['disposition'], reason: previous.reason, revision: previous.revision, duplicate: true });
            continue;
        }
        const stream = (await this.one("SELECT sequence,previous_event_id FROM streams WHERE match_id=$1 AND device_id=$2", [matchId, event.deviceId])) as StreamRow | undefined;
        if (event.clientSequence !== (stream?.sequence ?? 0) + 1 || event.previousEventId !== (stream?.previous_event_id ?? null)) {
            (await this.execute("INSERT INTO conflicting_submissions VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), matchId, principal.accountId, JSON.stringify(value), 'SEQUENCE_GAP_OR_REUSE', this.now()]));
            results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition: 'quarantined', reason: 'SEQUENCE_GAP_OR_REUSE', revision: null, duplicate: false });
            continue;
        }
        let reason: string | null = null;
        if (event.contractVersion !== EVENT_CONTRACT_VERSION || event.schemaVersion !== 1 || event.engineVersion !== ENGINE_VERSION)
            reason = 'UNSUPPORTED_EVENT_VERSION';
        else if (!grant || !currentCapability || event.controllerEpoch !== grant.epoch || event.deviceId !== grant.device_id)
            reason = 'STALE_CONTROLLER';
        else if (grant.frozen)
            reason = 'HANDOVER_WRITES_FROZEN';
        else if (event.baseRevision !== state.revision)
            reason = 'STALE_REVISION';
        if (!reason) {
            try {
                const next = reduceMatch(state, { ...event.command, actorId: principal.accountId });
                // Preserve true effective boundaries for late entries and compensating corrections.
                // The accepted projection's checkpoint is derived separately by replay.
                const effective = effectiveEventTime(state, next, event.command);
                if (effective.half !== event.effectiveHalf || effective.halfElapsedMs !== event.halfElapsedMs || effective.matchElapsedMs !== event.matchElapsedMs)
                    throw new Error('Effective playing-time evidence differs from the command.');
                state = next;
            }
            catch {
                reason = 'INVALID_MATCH_TRANSITION';
            }
        }
        const disposition = reason ? 'quarantined' : 'accepted';
        const revision = reason ? null : state.revision;
        (await this.execute("INSERT INTO events(event_id,match_id,device_id,client_sequence,envelope_json,signature,disposition,reason,revision,received_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [event.eventId, matchId, event.deviceId, event.clientSequence, JSON.stringify(event), signature, disposition, reason, revision, this.now(), principal.accountId]));
        (await this.execute("INSERT INTO streams(match_id,device_id,sequence,previous_event_id) VALUES($1,$2,$3,$4) ON CONFLICT(match_id,device_id) DO UPDATE SET sequence=excluded.sequence,previous_event_id=excluded.previous_event_id", [matchId, event.deviceId, event.clientSequence, event.eventId]));
        results.push({ eventId: event.eventId, clientSequence: event.clientSequence, disposition, reason, revision, duplicate: false });
    }
    if (results.some(item => item.disposition === 'accepted' && !item.duplicate))
        (await this.execute("UPDATE matches SET state_json=$1,last_sync_at=$2 WHERE id=$3", [JSON.stringify(state), this.now(), matchId]));
    (await this.audit(principal, 'events.uploaded', matchId, results.some(item => item.disposition === 'quarantined') ? 'review_required' : 'accepted'));
    if (results.some(item => item.disposition === 'accepted' && !item.duplicate))
        (await this.enqueueNotifications(row.team_id, row.season_id, 'match', matchId, `accepted-revision-${state.revision}`));
    return { results, revision: state.revision, pendingReview: results.some(item => item.disposition === 'quarantined') };
}
async quarantine(principal: Principal, matchId: string): Promise<unknown[]> {
    (await this.managerMatch(principal, matchId));
    return [...(await this.many("SELECT event_id,device_id,client_sequence,envelope_json,reason,received_at FROM events WHERE match_id=$1 AND disposition='quarantined' ORDER BY received_at,client_sequence", [matchId])), ...(await this.many("SELECT id,original_json,reason,created_at FROM conflicting_submissions WHERE match_id=$1 ORDER BY created_at", [matchId]))];
}
async offerHandover(principal: Principal, matchId: string, token: string | undefined, toAccountId: string, toDeviceId: string, baseRevision: number): Promise<Record<string, unknown>> {
    const row = (await this.managerMatch(principal, matchId));
    const grant = (await this.assertController(principal, matchId, token));
    if (grant.frozen)
        throw new AccessError('TRANSFER_PENDING', 409, 'A controller transfer is already pending.');
    const state = JSON.parse(row.state_json) as MatchState;
    if (state.revision !== baseRevision)
        throw new AccessError('STALE_REVISION', 409, 'Synchronise the accepted checkpoint before handover.');
    if (state.status.endsWith('_running'))
        throw new AccessError('CLOCK_ANCHOR_REQUIRED', 409, 'Running handover requires a verified UTC/device clock exchange. This development service supports handover while the match clock is already paused, at half-time or before kick-off; it never silently pauses play.');
    if (!validId(toAccountId) || !validDeviceId(toDeviceId))
        bad('A target account and canonical device identifier of at most 120 characters are required.');
    const target = (await this.one("SELECT * FROM accounts WHERE id=$1", [toAccountId])) as AccountRow | undefined;
    if (!target)
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    const targetPrincipal = { accountId: target.id, issuer: target.issuer, subject: target.subject, identityClassification: target.classification, adultVerified: !!target.adult_verified, strongAuth: !!target.strong_auth_enrolled, authenticatedAt: this.now(), status: target.status };
    assertCanManageTeam(targetPrincipal, (await this.memberships()), row.team_id, row.season_id, this.now());
    const id = randomUUID();
    (await this.execute("INSERT INTO transfers VALUES($1,$2,$3,$4,$5,$6,$7)", [id, matchId, grant.epoch, toAccountId, toDeviceId, 'pending', this.now()]));
    (await this.execute("UPDATE controller_grants SET frozen=1 WHERE match_id=$1", [matchId]));
    (await this.audit(principal, 'controller.transfer_offered', matchId, 'pending'));
    return { transferId: id, state: 'pending', acceptedRevision: state.revision };
}
async acceptHandover(principal: Principal, matchId: string, transferId: string, deviceId: string): Promise<Record<string, unknown>> {
    (await this.managerMatch(principal, matchId));
    assertAdultAuthority(principal, false, this.now());
    const transfer = (await this.one("SELECT * FROM transfers WHERE id=$1 AND match_id=$2", [transferId, matchId])) as {
        to_account_id: string;
        to_device_id: string;
        from_epoch: number;
        state: string;
    } | undefined;
    const grant = (await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId])) as GrantRow | undefined;
    if (!transfer || transfer.to_account_id !== principal.accountId || transfer.to_device_id !== deviceId)
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    if (transfer.state !== 'pending' || !grant || grant.epoch !== transfer.from_epoch || !grant.frozen)
        throw new AccessError('TRANSFER_CONFLICT', 409, 'Check the authoritative transfer status before retrying.');
    (await this.bindDevice(principal, deviceId));
    const capability = randomBytes(32).toString('base64url');
    const epoch = grant.epoch + 1;
    (await this.execute("UPDATE controller_grants SET epoch=$1,account_id=$2,device_id=$3,capability_hash=$4,frozen=0 WHERE match_id=$5", [epoch, principal.accountId, deviceId, digest(capability), matchId]));
    (await this.execute("UPDATE transfers SET state='accepted' WHERE id=$1", [transferId]));
    (await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), matchId, epoch, principal.accountId, grant.device_id, deviceId, 'transferred', null, this.now()]));
    (await this.audit(principal, 'controller.transferred', matchId, 'accepted'));
    return { epoch, deviceId, controllerToken: capability, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint, acceptedRevision: (JSON.parse((await this.match(matchId)).state_json) as MatchState).revision };
}
async recover(principal: Principal, matchId: string, deviceId: string, reason: string): Promise<Record<string, unknown>> {
    const row = (await this.managerMatch(principal, matchId));
    assertAdultAuthority(principal, true, this.now());
    if (!validDeviceId(deviceId) || typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500)
        bad('Recovery needs a target canonical device identifier of at most 120 characters and a concise audit reason.');
    (await this.bindDevice(principal, deviceId));
    const old = (await this.one("SELECT * FROM controller_grants WHERE match_id=$1", [matchId])) as GrantRow | undefined;
    const capability = randomBytes(32).toString('base64url');
    const epoch = (old?.epoch ?? 0) + 1;
    const state = JSON.parse(row.state_json) as MatchState;
    // Preserve the projection and evidence. No guessed clock/lineup or destructive reset.
    if (state.status.endsWith('_running')) {
        state.recoveryRequired = true;
        state.recoveryReason = 'Controller recovery: reconcile the referee clock and any unsynchronised old-device events.';
        (await this.execute("UPDATE matches SET state_json=$1 WHERE id=$2", [JSON.stringify(state), matchId]));
    }
    (await this.execute("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash,frozen) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT(match_id) DO UPDATE SET epoch=excluded.epoch,account_id=excluded.account_id,device_id=excluded.device_id,capability_hash=excluded.capability_hash,frozen=0", [matchId, epoch, principal.accountId, deviceId, digest(capability)]));
    (await this.execute("UPDATE transfers SET state='superseded' WHERE match_id=$1 AND state='pending'", [matchId]));
    (await this.execute("INSERT INTO controller_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), matchId, epoch, principal.accountId, old?.device_id ?? null, deviceId, 'recovered', reason.trim(), this.now()]));
    (await this.audit(principal, 'controller.recovered', matchId, 'reconciliation_required'));
    return { epoch, deviceId, controllerToken: capability, reconciliationRequired: true, checkpoint: (await this.download(principal, matchId, deviceId)).deviceCheckpoint };
}
private async staffRevision(teamId: string, seasonId: string): Promise<number> {
    const row = (await this.one("SELECT revision FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='staff'", [teamId, seasonId])) as {
        revision: number;
    } | undefined;
    return row?.revision ?? 0;
}
private async bumpStaffRevision(teamId: string, seasonId: string): Promise<number> {
    const revision = (await this.staffRevision(teamId, seasonId)) + 1;
    (await this.saveDocument(teamId, seasonId, 'staff', { revision }));
    return revision;
}
async managers(principal: Principal, teamId: string, seasonId: string, requestedRole?: string): Promise<ReturnType<typeof projectManagerRoster>> {
    assertTeamRole(principal, (await this.memberships()), teamId, seasonId, ['administrator'], this.now());
    assertAdultAuthority(principal, false, this.now());
    const accounts = (await this.many("SELECT * FROM accounts WHERE id IN (SELECT account_id FROM memberships WHERE team_id=$1)", [teamId])) as unknown as AccountRow[];
    const community = (await this.document<CommunityState>(teamId, seasonId, 'community'));
    const evidence: StaffAccountEvidence[] = accounts.map(account => ({ accountId: account.id, label: community.accounts.find(item => item.id === account.id)?.label ?? 'Verified adult account', status: account.status, identityClassification: account.classification, adultVerified: Boolean(account.adult_verified), strongAuthEnrolled: Boolean(account.strong_auth_enrolled) }));
    return projectManagerRoster({ principal, memberships: (await this.memberships()), accounts: evidence, teamId, seasonId, nowMs: this.now(), revision: (await this.staffRevision(teamId, seasonId)), requestedRole });
}
async assignManager(actor: Principal, teamId: string, seasonId: string, accountId: string, expectedRevision?: number): Promise<Record<string, unknown>> {
    assertTeamRole(actor, (await this.memberships()), teamId, seasonId, ['administrator'], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!validId(accountId))
        bad('A canonical account identifier is required.');
    if (expectedRevision !== undefined && (!nonnegative(expectedRevision) || expectedRevision !== (await this.staffRevision(teamId, seasonId))))
        throw new AccessError('STALE_REVISION', 409, 'Refresh the current staff assignments before changing them.');
    const account = (await this.one("SELECT * FROM accounts WHERE id=$1", [accountId])) as AccountRow | undefined;
    if (!account)
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    const target: Principal = { accountId: account.id, issuer: account.issuer, subject: account.subject, identityClassification: account.classification, adultVerified: !!account.adult_verified, strongAuth: !!account.strong_auth_enrolled, authenticatedAt: this.now(), status: account.status };
    assertCanAssignManager(actor, target, (await this.memberships()), teamId, seasonId, this.now());
    const alreadyActive = (await this.memberships()).some(item => item.accountId === accountId && item.teamId === teamId && item.seasonId === seasonId && item.role === 'manager' && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()));
    if (!alreadyActive) {
        (await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES($1,$2,$3,'manager') ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET revoked_at=NULL,expires_at=NULL", [accountId, teamId, seasonId]));
        (await this.bumpStaffRevision(teamId, seasonId));
        (await this.audit(actor, 'manager.assigned', teamId, 'accepted'));
    }
    return { accountId, teamId, seasonId, role: 'manager', revision: (await this.staffRevision(teamId, seasonId)), acceptedAt: new Date(this.now()).toISOString() };
}
async revokeManager(actor: Principal, teamId: string, seasonId: string, input: {
    accountId: string;
    reason: string;
    confirmRevocation: true;
}, expectedRevision?: number): Promise<Record<string, unknown>> {
    assertTeamRole(actor, (await this.memberships()), teamId, seasonId, ['administrator'], this.now());
    assertAdultAuthority(actor, true, this.now());
    if (!input || Object.keys(input).some(key => !['accountId', 'reason', 'confirmRevocation'].includes(key)) || !validId(input.accountId) || input.confirmRevocation !== true || typeof input.reason !== 'string' || input.reason.trim().length < 5 || input.reason.length > 500)
        bad('Confirm a scoped manager revocation and record its evidence reason.');
    if (expectedRevision !== undefined && (!nonnegative(expectedRevision) || expectedRevision !== (await this.staffRevision(teamId, seasonId))))
        throw new AccessError('STALE_REVISION', 409, 'Refresh the current staff assignments before changing them.');
    const member = (await this.one("SELECT account_id,revoked_at FROM memberships WHERE account_id=$1 AND team_id=$2 AND season_id=$3 AND role='manager'", [input.accountId, teamId, seasonId])) as {
        account_id: string;
        revoked_at: number | null;
    } | undefined;
    if (!member)
        throw new AccessError('NOT_FOUND', 404, 'That manager assignment is outside this scope.');
    if (member.revoked_at === null) {
        (await this.execute("UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4 AND role='manager'", [this.now(), input.accountId, teamId, seasonId]));
        (await this.execute("UPDATE controller_grants SET frozen=1 WHERE account_id=$1 AND team_id=$2 AND season_id=$3", [input.accountId, teamId, seasonId]));
        (await this.bumpStaffRevision(teamId, seasonId));
        (await this.audit(actor, 'manager.assignment_revoked', input.accountId, input.reason.trim()));
    }
    return { accountId: input.accountId, teamId, seasonId, role: 'manager', revision: (await this.staffRevision(teamId, seasonId)), acceptedAt: new Date(this.now()).toISOString(), revoked: true, controllerFrozen: true, otherSeasonAssignmentsRetained: true, remainingActiveTeamSeasons: (await this.memberships()).filter(item => item.accountId === input.accountId && item.teamId === teamId && item.role === 'manager' && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now())).map(item => item.seasonId) };
}
private async privacyRecords(principal: Principal): Promise<PrivacyRequestRecord[]> {
    const rows = (await this.many("SELECT id,account_id,kind,status,team_id,season_id,affected_memberships_json,created_at FROM privacy_requests WHERE account_id=$1 ORDER BY created_at,id", [principal.accountId])) as unknown as {
        id: string;
        account_id: string;
        kind: PrivacyRequestRecord['kind'];
        status: PrivacyRequestRecord['status'];
        team_id: string | null;
        season_id: string | null;
        affected_memberships_json: string | null;
        created_at: number;
    }[];
    return rows.map(row => ({ requestId: row.id, accountId: row.account_id, kind: row.kind, status: row.status, scope: row.kind === 'leave_team' ? (row.team_id && row.season_id ? { type: 'team_season' as const, teamId: row.team_id, seasonId: row.season_id } : null) : { type: 'all_memberships' as const }, affectedMemberships: row.affected_memberships_json === null ? null : JSON.parse(row.affected_memberships_json), createdAtMs: row.created_at }));
}
async privacyRequest(principal: Principal, input: unknown): Promise<ReturnType<typeof projectAccountPrivacyRequests>['items'][number]> {
    const plan = prepareAccountPrivacyRequest({ principal, memberships: (await this.memberships()), input, nowMs: this.now() });
    const pending = (await this.one("SELECT p.id FROM privacy_pending_keys k JOIN privacy_requests p ON p.id=k.request_id WHERE k.business_key=$1 AND p.account_id=$2 AND p.status='pending_verification_and_policy'", [plan.businessKey, principal.accountId])) as {
        id: string;
    } | undefined;
    let requestId = pending?.id;
    if (!requestId) {
        const retained = plan.scope.type === 'team_season'
            ? (await this.one("SELECT id FROM privacy_requests WHERE account_id=$1 AND kind=$2 AND team_id=$3 AND season_id=$4 AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1", [principal.accountId, plan.kind, plan.scope.teamId, plan.scope.seasonId])) as {
                id: string;
            } | undefined
            : (await this.one("SELECT id FROM privacy_requests WHERE account_id=$1 AND kind=$2 AND team_id IS NULL AND season_id IS NULL AND status='pending_verification_and_policy' ORDER BY created_at,id LIMIT 1", [principal.accountId, plan.kind])) as {
                id: string;
            } | undefined;
        requestId = retained?.id;
    }
    if (!requestId) {
        requestId = randomUUID();
        (await this.execute("INSERT INTO privacy_requests(id,account_id,kind,status,policy_version,verified_at,created_at,team_id,season_id,affected_memberships_json) VALUES($1,$2,$3,$4,NULL,NULL,$5,$6,$7,$8)", [requestId, principal.accountId, plan.kind, plan.status, this.now(), plan.scope.type === 'team_season' ? plan.scope.teamId : null, plan.scope.type === 'team_season' ? plan.scope.seasonId : null, JSON.stringify(plan.affectedMemberships)]));
        (await this.audit(principal, 'privacy.requested', requestId, 'pending_verification_and_policy'));
    }
    (await this.execute("INSERT INTO privacy_pending_keys(business_key,request_id) VALUES($1,$2) ON CONFLICT(business_key) DO UPDATE SET request_id=excluded.request_id", [plan.businessKey, requestId]));
    return (await this.privacyRequests(principal)).items.find(item => item.requestId === requestId)!;
}
async privacyRequests(principal: Principal): Promise<ReturnType<typeof projectAccountPrivacyRequests>> {
    return projectAccountPrivacyRequests({ principal, memberships: (await this.memberships()), records: (await this.privacyRecords(principal)), nowMs: this.now() });
}
/** Explicit setup seam: an authorised operator imports verified provider-to-account mappings; no token creates authority. */
async bindIdentity(accountId: string, issuer: string, subject: string): Promise<void> { (await this.execute("UPDATE accounts SET issuer=$1,subject=$2 WHERE id=$3", [issuer, subject, accountId])); }
async bindDevice(principal: Principal, deviceId: string): Promise<void> {
    const device = (await this.one("SELECT account_id FROM devices WHERE id=$1", [deviceId])) as {
        account_id: string;
    } | undefined;
    if (device && device.account_id !== principal.accountId)
        throw new AccessError('DEVICE_ACCOUNT_CONFLICT', 409, 'Enrol a separate device identity for this account.');
    (await this.execute("INSERT INTO devices(id,account_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [deviceId, principal.accountId]));
}
async teamMatches(principal: Principal, teamId: string, seasonId: string, requestedRole?: string): Promise<unknown[]> {
    assertTeamRole(principal, (await this.memberships()), teamId, seasonId, ['manager', 'player', 'spectator'], this.now());
    return (await Promise.all(((await this.many("SELECT id FROM matches WHERE team_id=$1 AND season_id=$2 ORDER BY id LIMIT 100", [teamId, seasonId])) as {
        id: string;
    }[]).map(async (row) => (await this.matchDto(principal, row.id, requestedRole)))));
}
async document<T>(teamId: string, seasonId: string, kind: string): Promise<T> {
    const row = (await this.one("SELECT value_json FROM documents WHERE team_id=$1 AND season_id=$2 AND kind=$3", [teamId, seasonId, kind])) as {
        value_json: string;
    } | undefined;
    if (!row)
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return JSON.parse(row.value_json) as T;
}
async saveDocument(teamId: string, seasonId: string, kind: string, state: {
    revision: number;
}): Promise<void> {
    (await this.execute("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(team_id,season_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json", [teamId, seasonId, kind, state.revision, JSON.stringify(state)]));
}
async enqueueNotifications(teamId: string, seasonId: string, category: TeamNotificationCategory, entityId: string, sourceId: string): Promise<number> {
    const workerJob=this.db.applicationContext?.kind==='worker_job';
    const observed=workerJob?(await this.one('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms'))?.now_ms:this.now();
    if(typeof observed!=='number'||!Number.isSafeInteger(observed)||observed<0)throw new Error('DATABASE_CLOCK_UNAVAILABLE');
    const recipients = new Map<string, Membership>();
    const priority = { manager: 3, player: 2, spectator: 1, administrator: 0 };
    for (const member of (await this.memberships()).filter(item => item.teamId === teamId && item.seasonId === seasonId && ['manager', 'player', 'spectator'].includes(item.role) && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > observed))) {
        const current = recipients.get(member.accountId);
        if (!current || priority[member.role] > priority[current.role])
            recipients.set(member.accountId, member);
    }
    let inserted = 0;
    for (const member of recipients.values()) {
        if (member.role === 'administrator' || member.role === 'player' && !member.playerId)
            continue;
        const businessKey = `notify:${digest(canonical([teamId, seasonId, category, entityId, sourceId, member.accountId, member.role]))}`;
        const job = createTeamNotificationJob({ id: randomUUID(), businessKey, accountId: member.accountId, teamId, seasonId, audience: member.role, playerId: member.role === 'player' ? member.playerId! : null, category, entityId, dueAtMs: observed });
        if(workerJob){
            const result=await this.one('SELECT longball.enqueue_award_notification($1,$2,$3::jsonb,$4) AS changes',[job.id,businessKey,JSON.stringify(job),job.dueAtMs]);inserted+=Number(result?.changes??0);
        }else{
            const result = (await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,'notification.dispatch',$3,$4) ON CONFLICT(business_key) DO NOTHING", [job.id, businessKey, JSON.stringify(job), job.dueAtMs]));
            inserted += Number(result.changes);
        }
    }
    return inserted;
}
async preparation(principal: Principal, teamId: string, seasonId: string): Promise<PreparationState> {
    assertCanManageTeam(principal, (await this.memberships()), teamId, seasonId, this.now());
    return (await this.document<PreparationState>(teamId, seasonId, 'preparation'));
}
async configuration(principal: Principal, teamId: string, seasonId: string, role?: string): Promise<ReturnType<typeof configurationServiceView>> {
    if (role)
        assertTeamRole(principal, (await this.memberships()), teamId, seasonId, role === 'manager' || role === 'administrator' ? [role] : [], this.now());
    const state = (await this.document<PreparationState>(teamId, seasonId, 'preparation'));
    return configurationServiceView({ principal, memberships: (await this.memberships()), preparation: state, seasonId, nowMs: this.now() });
}
async configurationCommand(principal: Principal, teamId: string, seasonId: string, command: PreparationCommand, role?: string): Promise<ReturnType<typeof configurationServiceView>> {
    (await this.configuration(principal, teamId, seasonId, role));
    if (!command || !['club.updated', 'team.updated'].includes(command.type))
        bad('Only club or team configuration can be changed in this context.');
    if (role && command.type === 'club.updated' && role !== 'administrator')
        throw new AccessError('NOT_FOUND', 404, 'Choose the current administrator context to administer the club.');
    const state = applyConfigurationServiceCommand({ principal, memberships: (await this.memberships()), preparation: (await this.document<PreparationState>(teamId, seasonId, 'preparation')), seasonId, nowMs: this.now(), command });
    (await this.saveDocument(teamId, seasonId, 'preparation', state));
    (await this.audit(principal, command.type, teamId, 'administrator_configuration_accepted'));
    return (await this.configuration(principal, teamId, seasonId, role));
}
private async seasonContext(principal: Principal, teamId: string, seasonId: string): Promise<SeasonRolloverContext> {
    const community = (await this.communityState(teamId, seasonId));
    const accounts = (await this.many("SELECT * FROM accounts", [])) as unknown as AccountRow[];
    const catalogue=await this.many('SELECT season_id,start_year FROM team_seasons WHERE team_id=$1',[teamId]) as {season_id:string;start_year:number|null}[];
    if(catalogue.some(season=>season.start_year===null))throw new AccessError('SEASON_SCOPE_REVIEW_REQUIRED',409,'Record the existing season catalogue before creating another season.');
    const existingSeasons=catalogue.map(season=>({teamId,id:season.season_id,startYear:season.start_year!}));
    return { principal, memberships: (await this.memberships()), existingSeasons, nowMs: this.now(), preparation: (await this.document<PreparationState>(teamId, seasonId, 'preparation')), records: (await this.document<RecordsState>(teamId, seasonId, 'records')), community,
        accounts: accounts.map(account => ({ accountId: account.id, label: community.accounts.find(item => item.id === account.id)?.label ?? 'Verified account', status: account.status, identityClassification: account.classification, adultVerified: Boolean(account.adult_verified), strongAuthEnrolled: Boolean(account.strong_auth_enrolled) })) };
}
async seasonOptions(principal: Principal, teamId: string, seasonId: string): Promise<ReturnType<typeof seasonRolloverOptions>> { return seasonRolloverOptions((await this.seasonContext(principal, teamId, seasonId))); }
async createSeason(principal: Principal, teamId: string, seasonId: string, command: SeasonRolloverCommand): Promise<ReturnType<typeof planSeasonRollover>['receipt']> {
    const context = (await this.seasonContext(principal, teamId, seasonId));
    const plan = planSeasonRollover({ ...context, command });
    if ((await this.one("SELECT kind FROM documents WHERE team_id=$1 AND season_id=$2 LIMIT 1", [teamId, plan.receipt.seasonId])))
        throw new AccessError('SEASON_EXISTS', 409, 'That destination season already has saved documents.');
    const team=await this.one("SELECT club_id FROM teams WHERE id=$1 AND scope_status='resolved'",[teamId]);
    const destination=plan.preparation.seasons.find(item=>item.id===plan.receipt.seasonId)!;
    if(!team||!destination)throw new AccessError('NOT_FOUND',404,'The authorised team season is unavailable.');
    await this.execute('INSERT INTO team_seasons(club_id,team_id,season_id,label,start_year,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7)',[team.club_id,teamId,destination.id,destination.label,destination.startYear,destination.startDate,destination.endDate]);
    for (const member of plan.memberships)
        (await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,player_id,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [member.accountId, member.teamId, member.seasonId, member.role, member.playerId ?? null, member.expiresAt ?? null, member.revokedAt ?? null]));
    (await this.saveDocument(teamId, plan.receipt.seasonId, 'preparation', plan.preparation));
    (await this.saveDocument(teamId, plan.receipt.seasonId, 'records', plan.records));
    (await this.saveDocument(teamId, plan.receipt.seasonId, 'community', plan.community));
    (await this.audit(principal, 'season.created_from_explicit_assignments', plan.receipt.seasonId, 'accepted_no_spectator_renewal'));
    return plan.receipt;
}
/** Called inside the preparation mutation transaction; current labels never rewrite saved match evidence. */
private async projectPreparationRecords(teamId: string, seasonId: string, preparation: PreparationState, sourceCommandId: string): Promise<void> {
    const previous = (await this.document<RecordsState>(teamId, seasonId, 'records'));
    const labels = new Map(previous.players.map(player => [player.id, player]));
    for (const profile of preparation.profiles.filter(profile => profile.seasonId === seasonId))
        labels.set(profile.playerId, { id: profile.playerId, label: profile.displayName });
    const players = [...labels.values()];
    const evidence = trainingAttendanceEvidence({ ...preparation, training: preparation.training.filter(session => session.seasonId === seasonId) });
    let records = previous;
    const at = new Date(this.now()).toISOString();
    if (canonical(players) !== canonical(previous.players))
        records = { ...records, players, revision: records.revision + 1,
            audit: [...records.audit, { commandId: `preparation-roster-${sourceCommandId}`, action: 'preparation.roster.projected', matchId: null, at, reason: 'Current season roster labels updated from preparation; saved match snapshots preserved.', before: null, after: null }] };
    if (canonical(evidence) !== canonical(previous.trainingAttendance))
        records = reduceRecords(records, { type: 'training.evidence.replace', commandId: `preparation-training-${sourceCommandId}`, at, actor: 'manager', evidence });
    if (records !== previous)
        (await this.saveDocument(teamId, seasonId, 'records', records));
}
async preparationCommand(principal: Principal, teamId: string, seasonId: string, command: PreparationCommand): Promise<PreparationState> {
    const previous = (await this.preparation(principal, teamId, seasonId));
    const types = ['club.updated', 'team.updated', 'season.rolled_over', 'profile.saved', 'profile.archived', 'formation.saved', 'fixture.saved', 'fixture.status_changed', 'fixture.response_recorded', 'fixture.selection_saved', 'fixture.attendance_recorded', 'fixture.prepared', 'training.saved', 'training.status_changed', 'training.response_recorded', 'training.attendance_recorded'];
    if (!command || !types.includes(command.type))
        bad('Unsupported preparation command.');
    if (command.type === 'season.rolled_over')
        throw new AccessError('SEASON_ASSIGNMENT_REQUIRED', 503, 'A connected new season requires approved manager/player assignments and explicit spectator renewal. The local rehearsal supports rollover; this service will not save an inaccessible new season or silently copy authority.');
    if (command.type === 'club.updated') {
        assertTeamRole(principal, (await this.memberships()), teamId, seasonId, ['administrator'], this.now());
        assertAdultAuthority(principal, true, this.now());
    }
    const state = reducePreparation(previous, command);
    if (command.type === 'fixture.prepared') {
        const snapshot = state.snapshots.find(snapshot => snapshot.fixtureId === command.fixtureId && snapshot.preparedRevision === command.expectedRevision + 1);
        if (!snapshot)
            throw new AccessError('PREPARATION_SNAPSHOT_REQUIRED', 409, 'The immutable prepared fixture snapshot is unavailable.');
        assertCanManageTeam(principal, (await this.memberships()), teamId, snapshot.seasonId, this.now());
        const config = fixtureMatchConfig(state, snapshot);
        const existing = (await this.one("SELECT * FROM matches WHERE id=$1", [config.matchId])) as MatchRow | undefined;
        if (!existing)
            (await this.insertMatch(config, teamId, snapshot.seasonId));
        else {
            if (existing.team_id !== teamId || existing.season_id !== snapshot.seasonId)
                throw new AccessError('MATCH_SCOPE_CONFLICT', 409, 'That fixture identity already belongs to another match scope.');
            if (canonical(JSON.parse(existing.config_json)) !== canonical(config)) {
                const matchState = JSON.parse(existing.state_json) as MatchState;
                const claimed = (await this.one("SELECT match_id FROM controller_grants WHERE match_id=$1", [config.matchId]));
                const history = (await this.one("SELECT event_id FROM events WHERE match_id=$1 LIMIT 1", [config.matchId]));
                if (claimed || history || matchState.revision !== 0 || matchState.status !== 'preparation')
                    throw new AccessError('MATCH_HISTORY_EXISTS', 409, 'This match already has a controller or recorded history. Preserve its saved snapshot and reconcile changes explicitly.');
                (await this.execute("UPDATE matches SET config_json=$1,state_json=$2 WHERE id=$3", [JSON.stringify(config), JSON.stringify(createMatch(config)), config.matchId]));
            }
        }
    }
    if (command.type.startsWith('training.') || command.type.startsWith('profile.'))
        (await this.projectPreparationRecords(teamId, seasonId, state, command.id));
    (await this.saveDocument(teamId, seasonId, 'preparation', state));
    (await this.audit(principal, command.type, teamId, 'accepted'));
    if (command.type === 'fixture.saved')
        (await this.enqueueNotifications(teamId, seasonId, 'schedule', command.fixture.id, command.id));
    else if (command.type === 'fixture.status_changed' || command.type === 'fixture.selection_saved')
        (await this.enqueueNotifications(teamId, seasonId, 'schedule', command.fixtureId, command.id));
    else if (command.type === 'training.saved')
        (await this.enqueueNotifications(teamId, seasonId, 'schedule', command.training.id, command.id));
    else if (command.type === 'training.status_changed')
        (await this.enqueueNotifications(teamId, seasonId, 'schedule', command.trainingId, command.id));
    return state;
}
async ownPreparation(principal: Principal, teamId: string, seasonId: string): Promise<Record<string, unknown>> {
    const membership = assertTeamRole(principal, (await this.memberships()), teamId, seasonId, ['player'], this.now());
    const state = (await this.document<PreparationState>(teamId, seasonId, 'preparation'));
    const profiles = state.profiles.filter(profile => profile.playerId === membership.playerId && profile.seasonId === seasonId && profile.active);
    if (profiles.length !== 1)
        throw new AccessError('NOT_FOUND', 404, 'The requested own-player profile is unavailable.');
    const profile = profiles[0];
    return { kind: 'player-preparation', revision: state.revision, team: { id: state.team.id, name: state.team.name, ageGroup: state.team.ageGroup }, season: state.seasons.find(season => season.id === seasonId), profile,
        fixtures: state.fixtures.filter(fixture => fixture.seasonId === seasonId).map(fixture => ({ id: fixture.id, opponent: fixture.opponent, playedDate: fixture.playedDate, kickoff: fixture.kickoff, venue: fixture.venue, homeAway: fixture.homeAway, status: fixture.status, response: fixture.responses[profile.id] ?? 'no_reply', selected: fixture.selectedProfileIds.includes(profile.id), attendance: fixture.attendance[profile.id] ?? 'not_recorded' })),
        training: state.training.filter(session => session.seasonId === seasonId).map(session => ({ id: session.id, date: session.date, time: session.time, venue: session.venue, status: session.status, expected: session.expectedProfileIds.includes(profile.id), response: session.responses[profile.id] ?? 'no_reply', attendance: session.attendance[profile.id] ?? 'not_recorded' })) };
}
async ownPreparationCommand(principal: Principal, teamId: string, seasonId: string, command: OwnPreparationCommand): Promise<Record<string, unknown>> {
    const membership = assertTeamRole(principal, (await this.memberships()), teamId, seasonId, ['player'], this.now());
    if (!command || !validId(command.id) || !nonnegative(command.expectedRevision) || !['own.preferences_saved', 'own.fixture_response_recorded', 'own.training_response_recorded'].includes(command.type))
        bad('A valid own-player command and source revision are required.');
    const allowed = command.type === 'own.preferences_saved' ? ['id', 'expectedRevision', 'type', 'preferences'] : command.type === 'own.fixture_response_recorded' ? ['id', 'expectedRevision', 'type', 'fixtureId', 'response'] : ['id', 'expectedRevision', 'type', 'trainingId', 'response'];
    if (Object.keys(command).some(key => !allowed.includes(key)))
        bad('Own-player commands cannot change another profile or manager-controlled fields.');
    const state = (await this.document<PreparationState>(teamId, seasonId, 'preparation'));
    const profiles = state.profiles.filter(profile => profile.playerId === membership.playerId && profile.seasonId === seasonId && profile.active);
    if (profiles.length !== 1)
        throw new AccessError('NOT_FOUND', 404, 'The requested own-player profile is unavailable.');
    const profile = profiles[0];
    const base = { id: command.id, expectedRevision: command.expectedRevision };
    const bound: PreparationCommand = command.type === 'own.preferences_saved' ? { ...base, type: 'profile.saved', profile: { ...profile, preferences: command.preferences } }
        : command.type === 'own.fixture_response_recorded' ? { ...base, type: 'fixture.response_recorded', fixtureId: command.fixtureId, profileId: profile.id, response: command.response }
            : { ...base, type: 'training.response_recorded', trainingId: command.trainingId, profileId: profile.id, response: command.response };
    const updated = reducePreparation(state, bound);
    if (bound.type.startsWith('training.') || bound.type.startsWith('profile.'))
        (await this.projectPreparationRecords(teamId, seasonId, updated, command.id));
    (await this.saveDocument(teamId, seasonId, 'preparation', updated));
    (await this.audit(principal, command.type, teamId, 'accepted'));
    return (await this.ownPreparation(principal, teamId, seasonId));
}
/** SQL account/membership records remain the authority; the serializable model is a projection. */
async communityState(teamId: string, seasonId: string): Promise<CommunityState> {
    const state = (await this.document<CommunityState>(teamId, seasonId, 'community'));
    const accounts = (await this.many("SELECT * FROM accounts WHERE status='active'", [])) as unknown as AccountRow[];
    const memberships = (await this.memberships());
    return { ...state,
        accounts: accounts.map(account => ({ id: account.id, label: state.accounts.find(person => person.id === account.id)?.label ?? 'Verified account', classification: account.classification === 'unclassified' ? 'spectator' : account.classification, adultVerified: !!account.adult_verified })),
        memberships: memberships.filter(item => item.role === 'manager' || item.role === 'player').map(item => ({ accountId: item.accountId, teamId: item.teamId, seasonId: item.seasonId, role: item.role as 'manager' | 'player', playerId: item.playerId, active: item.revokedAt == null && (item.expiresAt == null || item.expiresAt > this.now()) })),
    };
}
async communityActor(principal: Principal, teamId: string, seasonId: string, requestedRole?: string, invitationAcceptance = false): Promise<CommunityActor> {
    const memberships = (await this.memberships());
    if (invitationAcceptance)
        return { accountId: principal.accountId, teamId, seasonId, role: 'spectator' };
    const allowed = currentMemberships(principal, memberships, this.now()).filter(item => item.teamId === teamId && item.seasonId === seasonId && ['manager', 'player', 'spectator'].includes(item.role));
    const chosen = requestedRole ? allowed.find(item => item.role === requestedRole) : allowed.find(item => item.role === 'manager') ?? allowed[0];
    if (!chosen)
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    if (chosen.role === 'manager')
        assertAdultAuthority(principal, false, this.now());
    const actor = { accountId: principal.accountId, teamId, seasonId, role: chosen.role as CommunityActor['role'], playerId: chosen.playerId };
    const document = (await this.one("SELECT team_id FROM documents WHERE team_id=$1 AND season_id=$2 AND kind='community'", [teamId, seasonId]));
    if (document && !communityCanAccess((await this.communityState(teamId, seasonId)), actor, this.now()))
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return actor;
}
async community(principal: Principal, teamId: string, seasonId: string, role?: string): Promise<ReturnType<typeof getCommunityView> & {
    revision: number;
}> {
    const actor = (await this.communityActor(principal, teamId, seasonId, role));
    const state = (await this.communityState(teamId, seasonId));
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
}
async communityCommand(principal: Principal, teamId: string, seasonId: string, command: CommunityCommand, role?: string): Promise<ReturnType<typeof getCommunityView> & {
    revision: number;
}> {
    if (!command || !validId(command.id) || typeof command.type !== 'string')
        bad('A typed community command with a stable identity is required.');
    if (command.type === 'concern.updated' && !['under_review', 'resolved'].includes(command.status))
        bad('Invalid concern status.');
    if (command.type === 'concern.submitted' && (!['photo', 'uploader'].includes(command.targetType) || !['privacy', 'inappropriate', 'other'].includes(command.category)))
        bad('Invalid concern category.');
    if (command.type === 'uploader.hidden' && typeof command.hidden !== 'boolean')
        bad('Choose whether to hide the uploader.');
    if (command.type === 'privacy.drafted' && !['export', 'delete_global_account'].includes(command.requestType))
        bad('Invalid privacy request type.');
    if (command.type === 'match.registered')
        throw new AccessError('POLICY_APPROVAL_REQUIRED', 503, 'Connected award and sharing context must be derived from accepted match evidence, a verified finish-time anchor and independently approved competition policy. Caller-supplied trusted finish or sharing policy is not accepted.');
    const actor = (await this.communityActor(principal, teamId, seasonId, role, command.type === 'invite.accepted'));
    const previous = (await this.communityState(teamId, seasonId));
    const state = applyCommunityCommand(previous, actor, command, this.now());
    (await this.saveDocument(teamId, seasonId, 'community', state));
    if (['invite.accepted', 'invite.revoked', 'grant.revoked'].includes(command.type))
        (await this.synchronizeSpectatorMemberships(state));
    // Only an explicitly configured cutoff creates a job; Q15's +59 proposal is never silently selected.
    for (const match of state.matches.filter(match => match.voteCutoffAtMs !== null && match.finishQuality === 'trusted' && !state.awards.some(award => award.matchId === match.id))) {
        const key = `award:${teamId}:${seasonId}:${match.id}:${match.voteCutoffAtMs}`;
        (await this.execute("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(business_key) DO NOTHING", [randomUUID(), key, 'award.finalise', JSON.stringify({ teamId, seasonId, matchId: match.id }), match.voteCutoffAtMs!]));
    }
    (await this.audit(principal, command.type, teamId, 'accepted'));
    if (command.type === 'photo.submitted' || command.type === 'photo.revised' || command.type === 'photo.published' || command.type === 'photo.reviewed' && command.decision === 'approve')
        (await this.enqueueNotifications(teamId, seasonId, 'photos', command.photoId, command.id));
    if (command.type === 'award.finalised')
        (await this.enqueueNotifications(teamId, seasonId, 'awards', command.matchId, command.id));
    return { ...getCommunityView(state, actor, this.now()), revision: state.revision };
}
async synchronizeSpectatorMemberships(state: CommunityState): Promise<void> {
    const scopes = new Map<string, {
        accountId: string;
        teamId: string;
        seasonId: string;
    }>();
    for (const grant of state.grants)
        scopes.set(JSON.stringify([grant.accountId, grant.teamId, grant.seasonId]), { accountId: grant.accountId, teamId: grant.teamId, seasonId: grant.seasonId });
    for (const scope of scopes.values()) {
        const grants = state.grants.filter(grant => grant.accountId === scope.accountId && grant.teamId === scope.teamId && grant.seasonId === scope.seasonId);
        const active = grants.filter(grant => grant.revokedAtMs === null && grant.startsAtMs <= this.now() && grant.expiresAtMs > this.now());
        // A union of grants survives one revocation. Never let insertion order decide authority.
        const expiresAt = Math.max(...(active.length ? active : grants).map(grant => grant.expiresAtMs));
        const revokedAt = active.length ? null : Math.max(1, this.now());
        (await this.execute("INSERT INTO memberships(account_id,team_id,season_id,role,expires_at,revoked_at) VALUES($1,$2,$3,'spectator',$4,$5) ON CONFLICT(account_id,team_id,season_id,role) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=excluded.revoked_at", [scope.accountId, scope.teamId, scope.seasonId, expiresAt, revokedAt]));
    }
}
async media(principal: Principal, teamId: string, seasonId: string, photoId: string, mode: 'gallery' | 'own' | 'review', role?: string): Promise<ReturnType<typeof authorizeCommunityMedia>> {
    const actor = (await this.communityActor(principal, teamId, seasonId, role));
    const result = authorizeCommunityMedia((await this.communityState(teamId, seasonId)), actor, photoId, this.now(), mode);
    if (!result.allowed)
        throw new AccessError('NOT_FOUND', 404, 'The requested object is unavailable.');
    return result;
}
async recordsViewer(principal: Principal, teamId: string, seasonId: string, role?: string): Promise<RecordsViewer> {
    const actor = (await this.communityActor(principal, teamId, seasonId, role));
    return { actor: actor.role, playerId: actor.playerId, teamId, seasonId };
}
private async recordsContext(principal: Principal, teamId: string, seasonId: string, role?: string): Promise<RecordsServiceInput> {
    const viewer = (await this.recordsViewer(principal, teamId, seasonId, role));
    const rows = (await this.many("SELECT state_json FROM matches WHERE team_id=$1 AND season_id=$2 ORDER BY id", [teamId, seasonId])) as {
        state_json: string;
    }[];
    const community = (await this.communityState(teamId, seasonId));
    const actor = (await this.communityActor(principal, teamId, seasonId, viewer.actor));
    const filtered = getCommunityView(community, actor, this.now());
    return { principal, memberships: (await this.memberships()), nowMs: this.now(), requestedRole: viewer.actor, state: (await this.document<RecordsState>(teamId, seasonId, 'records')), acceptedMatches: rows.map(row => ({ teamId, seasonId, match: JSON.parse(row.state_json) as MatchState })), community: { accountId: principal.accountId, teamId, seasonId, audience: viewer.actor, playerId: viewer.playerId ?? null, revision: community.revision, view: { allowed: filtered.allowed, matches: filtered.matches, gallery: filtered.gallery } } };
}
async records(principal: Principal, teamId: string, seasonId: string, role?: string): Promise<Record<string, unknown>> { return recordsServiceView((await this.recordsContext(principal, teamId, seasonId, role))); }
async recordsExport(principal: Principal, teamId: string, seasonId: string, request: RecordsExportRequest, role?: string): Promise<ReturnType<typeof recordsServiceExport>> { return recordsServiceExport({ ...(await this.recordsContext(principal, teamId, seasonId, role)), request }); }
async recordsCommand(principal: Principal, teamId: string, seasonId: string, command: RecordsServiceCommand, role?: string): Promise<Record<string, unknown>> {
    const state = applyRecordsServiceCommand({ ...(await this.recordsContext(principal, teamId, seasonId, role)), command });
    (await this.saveDocument(teamId, seasonId, 'records', state));
    (await this.audit(principal, command.type, teamId, 'accepted'));
    return (await this.records(principal, teamId, seasonId, 'manager'));
}
}
