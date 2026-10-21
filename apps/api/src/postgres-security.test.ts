import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool,type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it,vi } from 'vitest';
import { PgDatabase, type PgApplicationContext } from './pg';
import { PostgresStore, SYNTHETIC_IDS } from './postgres-store';
import { PgMediaService } from './postgres-media';
import { PostgresActivationService } from './postgres-activation';
import { createTeamNotificationJob } from '../../../packages/application/src/team-notifications';
import { applyCommunityCommand,type CommunityState } from '../../../packages/application/src/community';
import { applyRuntimeGrants } from './runtime-grants';
const configured = process.env.LONGBALL_POSTGRES_TEST_URL;

describe.skipIf(!configured)('SEC10 actual PostgreSQL ancestry, RLS and pooled transaction context', () => {
  let admin: Pool, owner: PgDatabase, api: PgDatabase, worker: PgDatabase, store: PostgresStore;
  let database: string, directory: string;
  let roles: { owner: string; api: string; worker: string };
  const pools: PgDatabase[] = [];
  const context = (changes: Partial<Extract<PgApplicationContext, {kind:'actor'}>> = {}): Extract<PgApplicationContext, {kind:'actor'}> => ({
    kind: 'actor', accountId: 'synthetic-account-manager', issuer: 'urn:longball:synthetic', subject: 'synthetic-account-manager',
    strongAuth: true, authenticatedAtMs: Date.now(), nowMs: Date.now(), requestedRole: 'manager', operation: 'records.export',
    clubId: 'synthetic-richmond-rovers', teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, ...changes,
  });
  beforeAll(async () => {
    admin = new Pool({ connectionString: configured, max: 2 });
    const suffix = randomUUID().replaceAll('-', ''); database = `lb_scope_${suffix}`;
    roles = { owner: `lb_scope_owner_${suffix}`, api: `lb_scope_api_${suffix}`, worker: `lb_scope_worker_${suffix}` };
    for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(configured!); url.pathname = `/${database}`;
    const bootstrap = new Pool({ connectionString: url.href });
    try { await bootstrap.query(`CREATE SCHEMA longball AUTHORIZATION "${roles.owner}"`); await bootstrap.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); } finally { await bootstrap.end(); }
    const connect = (role: string, mode: 'apply'|'verify') => { const target = new URL(url); target.username = role; target.password = ''; const db = new PgDatabase(target.href, { migrationMode: mode, maximumConnections: 1 }); pools.push(db); return db; };
    owner = connect(roles.owner, 'apply'); await owner.migrate(); store = new PostgresStore(owner); await store.seedSynthetic();
    directory = await mkdtemp(join(tmpdir(), 'longball-rls-'));
    await PgMediaService.open({ directory, database: owner }); await new PostgresActivationService({ store }).initialize();
    await owner.query("INSERT INTO teams(id,name,club_id,scope_status) VALUES('fictional-cobalt-u10','Cobalt U10','synthetic-richmond-rovers','resolved')");
    await owner.query("INSERT INTO team_seasons(club_id,team_id,season_id) VALUES('synthetic-richmond-rovers','fictional-cobalt-u10',$1),('synthetic-richmond-rovers',$2,'fictional-prior-season')", [SYNTHETIC_IDS.seasonId, SYNTHETIC_IDS.teamId]);
    const config = JSON.parse(String((await store.one('SELECT config_json FROM matches WHERE id=$1', [SYNTHETIC_IDS.matchId]))!.config_json));
    for (const [id, team, season] of [['fictional-match-club-b','synthetic-other-team',SYNTHETIC_IDS.seasonId],['fictional-match-team-b','fictional-cobalt-u10',SYNTHETIC_IDS.seasonId],['fictional-match-season-b',SYNTHETIC_IDS.teamId,'fictional-prior-season']]) await store.insertMatch({ ...config, matchId: id }, team, season);
    await owner.query("INSERT INTO memberships(account_id,team_id,season_id,role,player_id) VALUES('synthetic-account-manager',$1,$2,'player','fictional-dual-role-player')", [SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId]);
    await applyRuntimeGrants(owner, { apiRole: roles.api, workerRole: roles.worker });
    api = connect(roles.api, 'verify'); worker = connect(roles.worker, 'verify'); await api.migrate(); await worker.migrate();
  });
  afterAll(async () => { for (const pool of pools) await pool.close(); if (database) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); for (const role of Object.values(roles ?? {})) await admin.query(`DROP ROLE "${role}"`); if (directory) await rm(directory, { recursive: true, force: true }); await admin.end(); });
  it('uses real non-owner non-bypass roles and RLS on every protected core/feature relation', async () => {
    expect((await api.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false});
    const protectedTables = ['clubs','teams','team_seasons','game_contexts','accounts','memberships','matches','documents','devices','controller_grants','events','streams','controller_history','conflicting_submissions','transfers','clock_challenges','clock_mappings','reconciliation_proposals','audit','idempotency','privacy_requests','privacy_pending_keys','jobs','media_uploads','lb_activation_children','lb_activation_issues','lb_activation_tokens','lb_activation_verification_requests'];
    const rows = (await api.query('SELECT c.relname,c.relrowsecurity,c.relowner=current_user::regrole AS owned FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=\'longball\' AND c.relname=ANY($1::text[])',[protectedTables])).rows;
    expect(rows).toHaveLength(protectedTables.length); expect(rows.every(row=>row.relrowsecurity===true && row.owned===false)).toBe(true);
    expect((await api.query('SELECT id FROM matches')).rows).toEqual([]);
    expect((await api.query('SELECT id FROM accounts')).rows).toEqual([]);
    await expect(api.query('ALTER TABLE matches DISABLE ROW LEVEL SECURITY')).rejects.toMatchObject({code:'42501'});
    await expect(api.query("SELECT * FROM claim_due_job('award.finalise',0,repeat('a',64))")).rejects.toMatchObject({code:'42501'});
    await expect(worker.query('SELECT * FROM privacy_requests')).rejects.toMatchObject({code:'42501'});
  });
  it('binds identity and selected role while blocking club, team and season substitutions', async () => {
    const identity = {kind:'identity' as const,issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',nowMs:Date.now()};
    expect((await api.withContext(identity,()=>api.query('SELECT id FROM accounts'))).rows).toEqual([{id:'synthetic-account-manager'}]);
    expect((await api.withContext(context(),()=>api.query('SELECT id FROM matches ORDER BY id'))).rows).toEqual([{id:SYNTHETIC_IDS.matchId}]);
    for (const invalid of [{clubId:'synthetic-other-club'}, {teamId:'fictional-cobalt-u10'}, {seasonId:'fictional-prior-season'}, {accountId:'synthetic-account-other-manager'}, {subject:'synthetic-account-other-manager'}]) expect((await api.withContext(context(invalid),()=>api.query('SELECT id FROM matches'))).rows).toEqual([]);
    await api.withContext(context({requestedRole:'administrator',operation:'staff.read'}),async()=>{expect((await api.query("SELECT * FROM documents WHERE kind IN('records','preparation')")).rows).toEqual([]);});
    await api.withContext(context({requestedRole:'administrator'}), async()=>{ expect((await api.query('SELECT * FROM documents')).rows).toEqual([]); expect((await api.query('SELECT * FROM matches')).rows).toEqual([]); });
    await api.withContext(context({requestedRole:'player'}), async()=>{ expect((await api.query('SELECT id FROM matches')).rowCount).toBe(1); expect((await api.query('SELECT * FROM controller_grants')).rows).toEqual([]); });
    await expect(api.withContext(context(),()=>api.query("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json) VALUES('cross-team','fictional-match-team-b','synthetic-account-manager','{}')"))).rejects.toMatchObject({code:'42501'});
    await expect(api.withContext(context(),()=>api.query("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json,club_id,team_id,season_id) VALUES('wrong-parent',$1,'synthetic-account-manager','{}','synthetic-other-club',$2,$3)",[SYNTHETIC_IDS.matchId,SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId]))).rejects.toMatchObject({code:'42501'});
  });
  it('keeps own-account lookups distinct from the full administrative membership view and honours an explicit lower role', async () => {
    const restricted = new PostgresStore(api);
    const identity = { issuer: 'urn:longball:synthetic', subject: 'synthetic-account-manager', strongAuth: true, authenticatedAt: Date.now() };
    const principal = await restricted.withIdentityContext(identity, () => restricted.principal(identity));
    await restricted.withActorContext(principal, { teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, requestedRole: 'administrator', operation: 'staff.read' }, async () => {
      const own = await restricted.myMemberships(principal);
      expect(own.every(item => item.accountId === principal.accountId)).toBe(true);
      expect(own.map(item => item.role).sort()).toEqual(['administrator', 'manager', 'player']);
      const team = await restricted.memberships();
      expect(team.some(item => item.accountId === 'synthetic-account-manager-2' && item.role === 'manager')).toBe(true);
      expect(team.length).toBeGreaterThan(own.length);
    });
    await restricted.withActorContext(principal, { matchId: SYNTHETIC_IDS.matchId, requestedRole: 'player', operation: 'match.read' }, async () => {
      const view = await restricted.matchDto(principal, SYNTHETIC_IDS.matchId, 'player');
      expect(view.audience).toBe('player');
      expect(view).not.toHaveProperty('state');
      expect(view.ownRecord).toMatchObject({ playerId: 'fictional-dual-role-player' });
    });
  });
  it('rechecks revoked manager membership and spectator grants without retaining own-account authority', async () => {
    const restricted = new PostgresStore(api);
    for (const [accountId, role] of [['synthetic-account-manager-2', 'manager'], ['synthetic-account-spectator', 'spectator']] as const) {
      const identity = { issuer: 'urn:longball:synthetic', subject: accountId, strongAuth: role === 'manager', authenticatedAt: Date.now() };
      const principal = await restricted.withIdentityContext(identity, () => restricted.principal(identity));
      const within = <T>(work: () => Promise<T>) => restricted.withActorContext(principal, { teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, requestedRole: role, operation: 'match.read' }, work);
      const original = await store.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
      expect(await within(() => restricted.myMemberships(principal))).toHaveLength(1);
      expect((await within(() => restricted.matchDto(principal, SYNTHETIC_IDS.matchId, role))).audience).toBe(role);
      try {
        if (role === 'manager') await owner.query('UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4', [Date.now(), accountId, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId]);
        else {
          const revoked: CommunityState = { ...original, grants: original.grants.map(grant => grant.accountId === accountId ? { ...grant, revokedAtMs: Date.now() } : grant) };
          await store.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', revoked);
        }
        expect(await within(() => restricted.myMemberships(principal))).toEqual([]);
        await expect(within(() => restricted.matchDto(principal, SYNTHETIC_IDS.matchId, role))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      } finally {
        if (role === 'manager') await owner.query('UPDATE memberships SET revoked_at=NULL WHERE account_id=$1 AND team_id=$2 AND season_id=$3', [accountId, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId]);
        else await store.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', original);
      }
    }
  });
  it('binds context kinds to the actual database login purpose', async()=>{
    await expect(api.query('SELECT * FROM runtime_roles')).rejects.toMatchObject({code:'42501'});
    await expect(worker.query("UPDATE runtime_roles SET purpose='api'")).rejects.toMatchObject({code:'42501'});
    for(const forged of [context(),{kind:'identity' as const,issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',nowMs:Date.now()}])await worker.withContext(forged,async()=>{expect((await worker.query('SELECT id FROM accounts')).rowCount).toBe(0);expect((await worker.query('SELECT * FROM documents')).rowCount).toBe(0);expect((await worker.query('SELECT id FROM matches')).rowCount).toBe(0);});
    await worker.withContext({kind:'invitation_activation',tokenHash:'a'.repeat(64),completionVerified:true,activationId:randomUUID(),nowMs:Date.now()},async()=>{expect((await worker.query("SELECT spectator_activation_account('synthetic-account-manager',true) AS allowed,invitation_live(repeat('a',64)) AS live")).rows[0]).toEqual({allowed:false,live:false});expect((await worker.query('SELECT id FROM accounts')).rowCount).toBe(0);});
    const id=randomUUID(),now=Date.now(),cap=randomBytes(32).toString('hex');
    await owner.query("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$1,'award.finalise',$2,$3)",[id,JSON.stringify({teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,matchId:SYNTHETIC_IDS.matchId}),now]);
    const claimed=await worker.withContext({kind:'worker_claim',jobKind:'award.finalise',nowMs:now},()=>worker.query('SELECT * FROM claim_due_job($1,$2,$3)',['award.finalise',now,cap]));
    expect(claimed.rowCount).toBe(1);
    const job={kind:'worker_job' as const,jobId:id,leaseToken:cap,clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,nowMs:Date.now()};
    expect((await worker.withContext(job,()=>worker.query('SELECT id FROM jobs'))).rows).toEqual([{id}]);
    const fanout=createTeamNotificationJob({id:randomUUID(),businessKey:randomUUID(),accountId:'synthetic-account-player-01',teamId:job.teamId,seasonId:job.seasonId,audience:'player',playerId:'synthetic-player-01',category:'awards',entityId:SYNTHETIC_IDS.matchId,dueAtMs:now});
    const enqueue=(payload:object=fanout,cap=job)=>worker.withContext(cap,()=>worker.query('SELECT enqueue_award_notification($1,$2,$3::jsonb,$4) AS changes',[('id' in payload)?payload.id:fanout.id,('businessKey' in payload)?payload.businessKey:fanout.businessKey,JSON.stringify(payload),now]));
    expect((await enqueue()).rows).toEqual([{changes:1}]);expect((await enqueue()).rows).toEqual([{changes:0}]);
    expect((await worker.withContext(job,()=>worker.query("SELECT id FROM jobs WHERE kind='notification.dispatch'"))).rowCount).toBe(0);
    await expect(enqueue({...fanout,id:randomUUID(),businessKey:randomUUID()})).rejects.toMatchObject({code:'23505'});
    await expect(enqueue({...fanout,category:'photos'})).rejects.toMatchObject({code:'23514'});
    await expect(enqueue({...fanout,entityId:'fictional-foreign-match'})).rejects.toMatchObject({code:'23514'});
    await expect(enqueue({...fanout,caption:'must never retain private text'})).rejects.toMatchObject({code:'23514'});
    await expect(enqueue(fanout,{...job,leaseToken:randomBytes(32).toString('hex')})).rejects.toMatchObject({code:'42501'});
    expect((await enqueue({...fanout,id:randomUUID(),businessKey:randomUUID(),accountId:'synthetic-account-other-manager',audience:'manager',playerId:null})).rows).toEqual([{changes:0}]);
    expect((await owner.query('SELECT award_source_job_id FROM jobs WHERE id=$1',[fanout.id])).rows).toEqual([{award_source_job_id:id}]);
    await api.withContext(job,async()=>{expect((await api.query('SELECT id FROM jobs')).rowCount).toBe(0);expect((await api.query('SELECT * FROM documents')).rowCount).toBe(0);expect((await api.query('SELECT id FROM matches')).rowCount).toBe(0);});
    await owner.query("UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1",[id]);
  });
  it('rolls back the community link when fresh PostgreSQL authority filters the final manifest update to zero',async()=>{
    const before=await store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');
    const uploadId=randomUUID(),photoId=`atomic-photo-${uploadId}`,actor={accountId:'synthetic-account-manager',role:'manager' as const,teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId};
    const next=applyCommunityCommand(before,actor,{id:randomUUID(),type:'photo.submitted',matchId:before.matches[0].id,photoId,art:'pitch',caption:'Fictional transaction fixture',policyAcknowledged:true},Date.now());
    await owner.query(`INSERT INTO media_uploads(id,request_id,request_signature,owner_id,team_id,season_id,match_id,photo_id,display_revision,status,expected_bytes,expected_sha,declared_mime,caption,token_hash,expires_at,created_at) VALUES($1,$1,'fixture',$2,$3,$4,$5,$6,1,'processed',1,repeat('a',64),'image/png','Fictional transaction fixture',repeat('b',64),$7,$8)`,[uploadId,actor.accountId,actor.teamId,actor.seasonId,before.matches[0].id,photoId,Date.now()+60000,Date.now()]);
    const media=await PgMediaService.open({directory,database:api}),query=api.query.bind(api);let boundaryReached=false;
    const spy=vi.spyOn(api,'query').mockImplementation(async<T extends QueryResultRow>(sql:string,values?:readonly unknown[])=>{
      if(sql.includes("UPDATE longball.media_uploads SET status='linked'")){
        boundaryReached=true;
        await owner.query('UPDATE memberships SET revoked_at=$1 WHERE account_id=$2 AND team_id=$3 AND season_id=$4',[Date.now(),actor.accountId,actor.teamId,actor.seasonId]);
      }
      return query<T>(sql,values);
    });
    try{
      await expect(api.withContext(context({operation:'media.complete'}),()=>api.transaction(async()=>{await new PostgresStore(api).saveDocument(actor.teamId,actor.seasonId,'community',next);await media.link(uploadId,next);}))).rejects.toMatchObject({code:'MEDIA_LINK_CONFLICT'});
      expect(boundaryReached).toBe(true);
      expect(await store.document<CommunityState>(actor.teamId,actor.seasonId,'community')).toEqual(before);
      expect((await owner.query('SELECT status FROM media_uploads WHERE id=$1',[uploadId])).rows[0].status).toBe('processed');
    }finally{spy.mockRestore();await owner.query('UPDATE memberships SET revoked_at=NULL WHERE account_id=$1 AND team_id=$2 AND season_id=$3',[actor.accountId,actor.teamId,actor.seasonId]);}
  });
  it('uses independent database time so future observations cannot claim or write a not-yet-due award',async()=>{
    const now=Date.now(),due=now+600000,id=randomUUID(),cap=randomBytes(32).toString('hex');
    await owner.query("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$1,'award.finalise',$2,$3)",[id,JSON.stringify({teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,matchId:SYNTHETIC_IDS.matchId}),due]);
    const claim=(observation:number)=>worker.withContext({kind:'worker_claim',jobKind:'award.finalise',nowMs:observation},()=>worker.query('SELECT * FROM claim_due_job($1,$2,$3)',['award.finalise',observation,cap]));
    await expect(claim(due)).rejects.toMatchObject({code:'42501'});
    expect((await claim(Date.now())).rowCount).toBe(0);
    const forged={kind:'worker_job' as const,jobId:id,leaseToken:cap,clubId:'synthetic-richmond-rovers',teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,nowMs:due};
    expect((await worker.withContext(forged,()=>worker.query("UPDATE documents SET revision=revision WHERE kind='community'"))).rowCount).toBe(0);
    expect((await owner.query('SELECT state,lease_until,lease_token_hash FROM jobs WHERE id=$1',[id])).rows).toEqual([{state:'pending',lease_until:null,lease_token_hash:null}]);
    // Even an observation inside the clock bound cannot pull a near-future job forward.
    await owner.query('UPDATE jobs SET due_at=$1 WHERE id=$2',[Date.now()+20000,id]);expect((await claim(Date.now()+25000)).rowCount).toBe(0);
    await owner.query("UPDATE jobs SET state='leased',lease_until=$1,lease_token_hash=repeat('0',64) WHERE id=$2",[Date.now()+20000,id]);expect((await claim(Date.now()+25000)).rowCount).toBe(0);
    await owner.query("UPDATE jobs SET state='pending',due_at=$1,lease_until=NULL,lease_token_hash=NULL WHERE id=$2",[Date.now()-1,id]);
    const before=Date.now();const row=(await claim(Date.now()+10000)).rows[0];const after=Date.now();expect(row).toBeTruthy();expect(Number(row.lease_until)).toBeGreaterThanOrEqual(before+30000);expect(Number(row.lease_until)).toBeLessThanOrEqual(after+30000);
    await owner.query("UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1",[id]);
    // Upgrade boundary: preserve old ledger rows while removing authority from a future lease.
    const legacySql=await readFile(new URL('../migrations/postgresql/007_worker_boundaries.sql',import.meta.url),'utf8');
    const legacyFunctions=legacySql.slice(legacySql.indexOf('CREATE OR REPLACE FUNCTION worker_job_valid'),legacySql.indexOf('CREATE OR REPLACE FUNCTION enqueue_award_notification'));
    await owner.query(legacyFunctions);
    const legacyId=randomUUID(),legacyDue=Date.now()+600000,legacyCap=randomBytes(32).toString('hex');
    await owner.query("INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$1,'award.finalise',$2,$3)",[legacyId,JSON.stringify({teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,matchId:SYNTHETIC_IDS.matchId}),legacyDue]);
    expect((await worker.withContext({kind:'worker_claim',jobKind:'award.finalise',nowMs:legacyDue},()=>worker.query('SELECT * FROM claim_due_job($1,$2,$3)',['award.finalise',legacyDue,legacyCap]))).rowCount).toBe(1);
    const legacyContext={...forged,jobId:legacyId,leaseToken:legacyCap,nowMs:Date.now()};
    expect((await worker.withContext(legacyContext,()=>worker.query("UPDATE documents SET revision=revision WHERE kind='community'"))).rowCount).toBe(1);
    await owner.query(await readFile(new URL('../migrations/postgresql/009_dispatch_database_clock.sql',import.meta.url),'utf8'));
    await worker.withContext({...legacyContext,nowMs:Date.now()},async()=>{expect((await worker.query("UPDATE documents SET revision=revision WHERE kind='community'")).rowCount).toBe(0);expect((await worker.query('SELECT * FROM jobs')).rowCount).toBe(0);});
    expect((await owner.query('SELECT state,lease_until FROM jobs WHERE id=$1',[legacyId])).rows[0]).toEqual({state:'leased',lease_until:legacyDue+30000});

  });
  it('hides linked private, replaced, removed and hidden-uploader media manifests from another player',async()=>{
    const state=await store.document<CommunityState>(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community');
    const match={...state.matches[0],id:SYNTHETIC_IDS.matchId,sharing:'fictional_review_only' as const};
    const photo: CommunityState['photos'][number]={id:'fictional-policy-photo',matchId:match.id,teamId:SYNTHETIC_IDS.teamId,seasonId:SYNTHETIC_IDS.seasonId,uploaderAccountId:'synthetic-account-player-01',uploaderRole:'player',currentRevision:1,publishedRevision:null as number|null,removedAtMs:null as number|null,revisions:[{version:1,status:'pending' as const,art:'ball' as const,caption:'Private fictional caption',createdAtMs:Date.now(),reviewedAtMs:null,reviewerAccountId:null,rejectionReason:null,processing:'synthetic_derivative_ready' as const}]};
    state.matches.push(match);state.photos.push(photo);await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);
    await owner.query("INSERT INTO media_uploads(id,request_id,request_signature,owner_id,team_id,season_id,match_id,photo_id,display_revision,status,expected_bytes,expected_sha,declared_mime,caption,token_hash,expires_at,created_at) VALUES('fictional-policy-upload','fictional-policy-request','signature','synthetic-account-player-01',$1,$2,$3,$4,1,'linked',1,repeat('0',64),'image/jpeg','private caption',repeat('1',64),$5,$6)",[SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,match.id,photo.id,Date.now()+60000,Date.now()]);
    const viewer=context({accountId:'synthetic-account-player-02',subject:'synthetic-account-player-02',strongAuth:false,requestedRole:'player',operation:'media.gateway'});
    const count=async()=> (await api.withContext(viewer,()=>api.query("SELECT * FROM media_uploads WHERE id='fictional-policy-upload'"))).rowCount;
    expect(await count()).toBe(0);
    photo.publishedRevision=1;photo.revisions[0].status='published';await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);expect(await count()).toBe(1);
    photo.publishedRevision=2;await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);expect(await count()).toBe(0);
    photo.publishedRevision=1;photo.removedAtMs=Date.now();await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);expect(await count()).toBe(0);
    photo.removedAtMs=null;state.hiddenUploaders.push({accountId:viewer.accountId,uploaderAccountId:photo.uploaderAccountId});await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);expect(await count()).toBe(0);
    state.hiddenUploaders=[];photo.revisions[0].status='withdrawn';await store.saveDocument(SYNTHETIC_IDS.teamId,SYNTHETIC_IDS.seasonId,'community',state);expect(await count()).toBe(0);
  });
  it('lets an administrator freeze only the named controller without reading match state or rewriting its capability',async()=>{
    await owner.query("INSERT INTO devices(id,account_id) VALUES('fictional-controller-device','synthetic-account-manager-2')");
    await owner.query("INSERT INTO controller_grants(match_id,epoch,account_id,device_id,capability_hash) VALUES($1,1,'synthetic-account-manager-2','fictional-controller-device','fictional-private-hash')",[SYNTHETIC_IDS.matchId]);
    const admin=context({accountId:'synthetic-account-admin',subject:'synthetic-account-admin',requestedRole:'administrator',operation:'staff.revoke',staffTargetAccountId:'synthetic-account-manager-2'});
    await api.withContext(admin,async()=>{
      expect((await api.query('SELECT id FROM matches')).rowCount).toBe(0);
      expect((await api.query('SELECT account_id FROM controller_grants')).rows).toEqual([{account_id:'synthetic-account-manager-2'}]);
      await expect(api.query('UPDATE controller_grants SET epoch=epoch+1,frozen=1')).rejects.toMatchObject({code:'42501'});
      expect((await api.query('UPDATE controller_grants SET frozen=1')).rowCount).toBe(1);
    });
    expect((await api.withContext({...admin,staffTargetAccountId:'synthetic-account-manager-3'},()=>api.query('SELECT * FROM controller_grants'))).rowCount).toBe(0);
    expect((await owner.query('SELECT epoch,frozen FROM controller_grants')).rows).toEqual([{epoch:1,frozen:1}]);
  });
  it('cleans SET LOCAL after commits, errors, pool reuse and concurrent logical contexts', async () => {
    for(let index=0;index<3;index++) {
      await api.withContext(context(),()=>api.transaction(async()=>{expect((await api.query('SELECT id FROM matches')).rowCount).toBe(1);}));
      await expect(api.withContext(context(),()=>api.transaction(()=>api.query('SELECT 1/0')))).rejects.toMatchObject({code:'22012'});
      expect((await api.query("SELECT nullif(current_setting('longball.context',true),'') AS value")).rows[0]?.value).toBeNull();
      expect((await api.query('SELECT id FROM matches')).rowCount).toBe(0);
    }
    const other=context({accountId:'synthetic-account-other-manager',subject:'synthetic-account-other-manager',clubId:'synthetic-other-club',teamId:'synthetic-other-team'});
    const results=await Promise.all(Array.from({length:10},(_,index)=>api.withContext(index%2?other:context(),async()=>{await Promise.resolve();return(await api.query('SELECT id FROM matches')).rows.map(row=>row.id);}))); 
    for(let index=0;index<results.length;index++)expect(results[index]).toEqual([index%2?'fictional-match-club-b':SYNTHETIC_IDS.matchId]);
    await expect(api.withContext(context(),()=>api.withContext(other,()=>api.query('SELECT 1')))).rejects.toThrow('cannot widen');
    const outer=context(); await expect(api.withContext(outer,()=>api.transaction(()=>api.withContext({...outer,matchId:SYNTHETIC_IDS.matchId},()=>api.query('SELECT 1'))))).rejects.toThrow('before opening');
    let releaseChild!:()=>void;const childGate=new Promise<void>(resolve=>{releaseChild=resolve;});let childTask!:Promise<unknown>;
    const detachedParent=context();
    await api.withContext(detachedParent,async()=>{childTask=api.withContext({...detachedParent,matchId:SYNTHETIC_IDS.matchId},async()=>{await childGate;return api.query('SELECT id FROM matches');});await Promise.resolve();});
    releaseChild();await expect(childTask).rejects.toThrow('application context has ended');
    await api.withContext(context(),async()=>{
      let releaseQuery!:()=>void;const queryGate=new Promise<void>(resolve=>{releaseQuery=resolve;});let queryTask!:Promise<unknown>;
      await api.transaction(async()=>{queryTask=(async()=>{await queryGate;return api.query('SELECT id FROM matches');})();});
      releaseQuery();await expect(queryTask).rejects.toThrow('transaction has ended');
      expect((await api.query('SELECT id FROM matches')).rowCount).toBe(1);
    });
    let deferred:()=>Promise<unknown>=async()=>{}; await api.withContext(context(),()=>{deferred=()=>api.query('SELECT id FROM matches');});
    // A saved callback outside ALS has no context and therefore no data authority.
    expect((await deferred() as {rowCount:number}).rowCount).toBe(0);
  });
  it('keeps composite parent constraints effective independently of the normal derivation trigger', async () => {
    await expect(owner.transaction(async()=>{await owner.query('ALTER TABLE clock_challenges DISABLE TRIGGER clock_challenges_scope');await owner.query("INSERT INTO clock_challenges(id,match_id,account_id,challenge_json,club_id,team_id,season_id) VALUES('fk-substitution',$1,'synthetic-account-manager','{}','synthetic-other-club','synthetic-other-team',$2)",[SYNTHETIC_IDS.matchId,SYNTHETIC_IDS.seasonId]);})).rejects.toMatchObject({code:'23503'});
    expect((await owner.query("SELECT tgenabled FROM pg_trigger WHERE tgname='clock_challenges_scope'")).rows[0]?.tgenabled).toBe('O');
  });
  it('rolls back security expansion on a late FK failure and retains unresolved legacy ancestry', async()=>{
    const fixture=`lb_scope_legacy_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${fixture}"`);
    const url=new URL(configured!);url.pathname=`/${fixture}`;const legacy=new PgDatabase(url.href);
    try {
      await legacy.query('CREATE SCHEMA longball');
      for(const file of ['002_runtime.sql','003_clock_review.sql','004_account_requests.sql'])await legacy.query(await readFile(new URL(`../migrations/postgresql/${file}`,import.meta.url),'utf8'));
      await legacy.query("INSERT INTO teams(id,name) VALUES('unresolved-team','Legacy without club')");
      await legacy.query("INSERT INTO accounts(id,issuer,subject,classification) VALUES('legacy-account','urn:legacy','legacy','child_shared')");
      await legacy.query("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES('legacy-account','unresolved-team','legacy-season','player')");
      await legacy.query("INSERT INTO documents(team_id,season_id,kind,revision,value_json) VALUES('unresolved-team','legacy-season','community',0,'{}')");
      const sql=await readFile(new URL('../migrations/postgresql/005_scope_security.sql',import.meta.url),'utf8');
      await expect(legacy.transaction(async()=>{await legacy.query(sql);await legacy.query("INSERT INTO team_seasons(club_id,team_id,season_id) VALUES('missing-club','unresolved-team','bad')");})).rejects.toMatchObject({code:'23503'});
      expect((await legacy.query("SELECT to_regclass('longball.clubs') AS object")).rows[0]?.object).toBeNull();
      expect((await legacy.query("SELECT count(*)::integer AS count FROM memberships")).rows[0]?.count).toBe(1);
      await legacy.transaction(()=>legacy.query(sql));
      expect((await legacy.query('SELECT club_id,scope_status FROM teams')).rows).toEqual([{club_id:null,scope_status:'unresolved'}]);
      await legacy.query("INSERT INTO runtime_roles(role_name,purpose) VALUES($1,'api')",[roles.api]);
      await legacy.query(`GRANT USAGE ON SCHEMA longball TO "${roles.api}"`);
      await legacy.query(`GRANT SELECT ON longball.accounts,longball.memberships,longball.matches,longball.documents,longball.teams,longball.team_seasons,longball.jobs TO "${roles.api}"`);
      await legacy.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA longball TO "${roles.api}"`);
      const restrictedUrl=new URL(url);restrictedUrl.username=roles.api;restrictedUrl.password='';const restricted=new PgDatabase(restrictedUrl.href);
      try {await restricted.withContext({kind:'actor',accountId:'legacy-account',issuer:'urn:legacy',subject:'legacy',strongAuth:false,authenticatedAtMs:Date.now(),nowMs:Date.now(),teamId:'unresolved-team',seasonId:'legacy-season',requestedRole:'player'},async()=>{expect((await restricted.query('SELECT * FROM memberships')).rowCount).toBe(0);expect((await restricted.query('SELECT * FROM documents')).rowCount).toBe(0);});} finally {await restricted.close();}
    } finally {await legacy.close();await admin.query(`DROP DATABASE "${fixture}" WITH (FORCE)`);}
  });
});
