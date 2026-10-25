import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DevelopmentStore, canonical } from './store';
import { PostgresStore } from './postgres-store';
import { sqliteRuntimeStore } from './runtime-store';

export interface ExportRow {
  id: string; job_id: string; account_id: string; issuer: string; subject: string;
  team_id: string; season_id: string; role: 'manager' | 'player' | 'spectator'; player_id: string | null;
  request_json: string; status: 'queued' | 'working' | 'ready' | 'failed' | 'expired';
  created_at: number; expires_at: number; generated_at: number | null; failure_code: string | null;
  publication_json: string; source_fingerprint: string; snapshot_ciphertext: string | null;
  artifact_ciphertext: string | null; artifact_sha256: string | null; key_id: string; version: number;
}
export interface ExportClaim {
  row: ExportRow; jobId: string; attempt: number; leaseToken: string;
  clubId: string; teamId: string; seasonId: string; claimedAtMs: number; claimedMonotonicMs: number;
}
interface JobRow {
  id: string; attempts: number; state: string; lease_until: number | null; lease_token_hash: string | null;
  club_id?: string; team_id?: string; season_id?: string;
}
type Transaction = <T>(work: () => Promise<T>) => Promise<T>;
const KIND = 'report.export';
const LEASE_MS = 30_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const columns = ['id','job_id','account_id','issuer','subject','team_id','season_id','role','player_id','request_json','status','created_at','expires_at','generated_at','failure_code','publication_json','source_fingerprint','snapshot_ciphertext','artifact_ciphertext','artifact_sha256','key_id','version'] as const;
const failureCode = (value: string) => /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'EXPORT_GENERATION_FAILED';

/** Only encrypted report bytes cross this repository boundary. A lease grants one export, never its raw source documents. */
export class ReportExportRepository {
  private readonly transaction: Transaction;
  constructor(readonly source: DevelopmentStore | PostgresStore, transaction?: Transaction) {
    const sqliteTransaction = source instanceof DevelopmentStore ? sqliteRuntimeStore(source).store.transaction : undefined;
    this.transaction = transaction ?? (source instanceof PostgresStore
      ? work => source.transaction(work)
      : work => sqliteTransaction!(work));
  }
  async initialize(): Promise<void> {
    if (this.source instanceof PostgresStore) return;
    // Feature initialization is independent of the existing domain-store migration number.
    // The same SQLite write lock protects API/worker startup racing on a new database.
    await this.transaction(async () => {
      if (!(this.source instanceof DevelopmentStore)) return;
      const names = this.source.database.prepare('PRAGMA table_info(jobs)').all() as unknown as { name: string }[];
      if (!names.some(item => item.name === 'lease_token_hash')) this.source.database.exec('ALTER TABLE jobs ADD COLUMN lease_token_hash TEXT');
      this.source.database.exec(`CREATE TABLE IF NOT EXISTS report_exports (
        id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),account_id TEXT NOT NULL REFERENCES accounts(id),issuer TEXT NOT NULL,subject TEXT NOT NULL,
        team_id TEXT NOT NULL,season_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('manager','player','spectator')),player_id TEXT,request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN('queued','working','ready','failed','expired')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,generated_at INTEGER,failure_code TEXT,
        publication_json TEXT NOT NULL,source_fingerprint TEXT NOT NULL,snapshot_ciphertext TEXT,artifact_ciphertext TEXT,artifact_sha256 TEXT,key_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
        CHECK((role='player' AND player_id IS NOT NULL) OR (role<>'player' AND player_id IS NULL)),
        CHECK(expires_at>created_at AND expires_at<=created_at+86400000),
        CHECK(length(COALESCE(snapshot_ciphertext,''))<=7340032 AND length(COALESCE(artifact_ciphertext,''))<=7340032),
        CHECK(status<>'ready' OR (artifact_ciphertext IS NOT NULL AND artifact_sha256 IS NOT NULL AND generated_at IS NOT NULL)),
        CHECK(status NOT IN('failed','expired') OR (snapshot_ciphertext IS NULL AND artifact_ciphertext IS NULL AND artifact_sha256 IS NULL))
      ); CREATE INDEX IF NOT EXISTS report_exports_expiry ON report_exports(expires_at,id) WHERE status<>'expired';`);
    });
  }
  async create(row: ExportRow): Promise<void> {
    await this.transaction(async () => {
      const payload = JSON.stringify({ exportId: row.id, teamId: row.team_id, seasonId: row.season_id, accountId: row.account_id, audience: row.role, playerId: row.player_id });
      if (this.source instanceof PostgresStore) {
        await this.source.execute('INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES($1,$2,$3,$4,$5)', [row.job_id,`report-export:${row.id}`,KIND,payload,row.created_at]);
        await this.source.execute(`INSERT INTO report_exports(${columns.join(',')}) VALUES(${columns.map((_,index) => `$${index + 1}`).join(',')})`, columns.map(name => row[name]));
      } else {
        this.source.database.prepare('INSERT INTO jobs(id,business_key,kind,payload_json,due_at) VALUES(?,?,?,?,?)').run(row.job_id,`report-export:${row.id}`,KIND,payload,row.created_at);
        this.source.database.prepare(`INSERT INTO report_exports(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(name => row[name]));
      }
    });
  }
  async get(id: string): Promise<ExportRow | undefined> {
    return this.source instanceof PostgresStore
      ? await this.source.one('SELECT * FROM report_exports WHERE id=$1', [id]) as unknown as ExportRow | undefined
      : this.source.database.prepare('SELECT * FROM report_exports WHERE id=?').get(id) as unknown as ExportRow | undefined;
  }
  async sourceFingerprint(teamId: string, seasonId: string): Promise<string> {
    if (this.source instanceof PostgresStore) {
      const row = await this.source.one('SELECT longball.report_export_source($1,$2) AS value', [teamId,seasonId]);
      if (typeof row?.value !== 'string' || !/^[a-f0-9]{64}$/.test(row.value)) throw new Error('EXPORT_SOURCE_UNAVAILABLE');
      return row.value;
    }
    return this.sqliteFingerprint(teamId,seasonId);
  }
  private sqliteFingerprint(teamId: string, seasonId: string): string {
    if (!(this.source instanceof DevelopmentStore)) throw new Error('EXPORT_SOURCE_UNAVAILABLE');
    const documents = this.source.database.prepare("SELECT kind,revision,value_json FROM documents WHERE team_id=? AND season_id=? AND kind IN('records','preparation','community') ORDER BY kind").all(teamId,seasonId);
    const matches = this.source.database.prepare('SELECT id,config_json,state_json,sharing_policy_json,last_sync_at FROM matches WHERE team_id=? AND season_id=? ORDER BY id').all(teamId,seasonId);
    return digest(canonical({ documents,matches }));
  }
  async current(row: ExportRow): Promise<{ allowed: boolean; sourceFingerprint: string; nowMs: number }> {
    if (this.source instanceof PostgresStore) {
      const result = await this.source.one('SELECT * FROM longball.report_export_current($1)', [row.id]);
      if (typeof result?.allowed !== 'boolean' || !Number.isSafeInteger(result.now_ms)) throw new Error('EXPORT_AUTHORITY_UNAVAILABLE');
      return { allowed: result.allowed, sourceFingerprint: typeof result.source_fingerprint === 'string' ? result.source_fingerprint : '', nowMs: Number(result.now_ms) };
    }
    const nowMs = this.source.now();
    const account = this.source.database.prepare('SELECT issuer,subject,status,classification,adult_verified,strong_auth_enrolled FROM accounts WHERE id=?').get(row.account_id) as { issuer:string;subject:string;status:string;classification:string;adult_verified:number;strong_auth_enrolled:number } | undefined;
    const member = this.source.memberships().some(item => item.accountId === row.account_id && item.teamId === row.team_id && item.seasonId === row.season_id && item.role === row.role && item.revokedAt == null && (item.expiresAt == null || item.expiresAt > nowMs) && (row.role !== 'player' || item.playerId === row.player_id));
    const community = row.role === 'spectator' ? this.source.database.prepare("SELECT value_json FROM documents WHERE team_id=? AND season_id=? AND kind='community'").get(row.team_id,row.season_id) as {value_json:string}|undefined : undefined;
    const grant = row.role !== 'spectator' || Boolean(community && (JSON.parse(community.value_json) as {grants:{accountId:string;teamId:string;seasonId:string;revokedAtMs:number|null;startsAtMs:number;expiresAtMs:number}[]}).grants.some(item=>item.accountId===row.account_id&&item.teamId===row.team_id&&item.seasonId===row.season_id&&item.revokedAtMs===null&&item.startsAtMs<=nowMs&&item.expiresAtMs>nowMs));
    const allowed = Boolean(account && account.issuer === row.issuer && account.subject === row.subject && account.status === 'active' && member && grant && (row.role !== 'manager' || (account.classification === 'adult_individual' && account.adult_verified === 1 && account.strong_auth_enrolled === 1)));
    return { allowed,sourceFingerprint: allowed ? this.sqliteFingerprint(row.team_id,row.season_id) : '',nowMs };
  }
  async claim(): Promise<ExportClaim | null> {
    const leaseToken = randomBytes(32).toString('hex');
    if (this.source instanceof PostgresStore) {
      const store = this.source, observed = Date.now();
      const job = await store.db.withContext({ kind:'worker_claim',jobKind:KIND,nowMs:observed }, () => store.one('SELECT * FROM longball.claim_due_job($1,$2,$3)', [KIND,observed,leaseToken])) as unknown as JobRow | undefined;
      if (!job) return null;
      if (typeof job.club_id !== 'string' || typeof job.team_id !== 'string' || typeof job.season_id !== 'string' || !Number.isSafeInteger(job.lease_until)) throw new Error('EXPORT_JOB_SCOPE_CONFLICT');
      const claim: ExportClaim = { row: undefined as unknown as ExportRow,jobId:job.id,attempt:job.attempts+1,leaseToken,clubId:job.club_id,teamId:job.team_id,seasonId:job.season_id,claimedAtMs:job.lease_until!-LEASE_MS,claimedMonotonicMs:performance.now() };
      return this.withClaim(claim, () => this.transaction(async () => {
        const incremented = await store.execute("UPDATE jobs SET attempts=attempts+1 WHERE id=$1 AND state='leased' AND attempts=$2", [job.id,job.attempts]);
        if (!incremented.changes) return null;
        const row = await store.one('SELECT * FROM report_exports WHERE job_id=$1', [job.id]) as unknown as ExportRow | undefined;
        if (!row) { await store.execute("UPDATE jobs SET state='failed',lease_until=NULL,last_error_code='EXPORT_NOT_FOUND' WHERE id=$1", [job.id]); return null; }
        claim.row = row;
        if (row.status === 'ready' || row.status === 'failed' || row.status === 'expired') { await store.execute("UPDATE jobs SET state=$1,lease_until=NULL,last_error_code=$2 WHERE id=$3", [row.status === 'ready' ? 'completed' : 'failed',row.failure_code,job.id]); return null; }
        if (claim.attempt > 3) { await this.fail(claim,'EXPORT_RETRY_LIMIT',true); return null; }
        const updated = await store.one("UPDATE report_exports SET status='working',version=version+1 WHERE id=$1 AND status IN('queued','working') RETURNING *", [row.id]) as unknown as ExportRow | undefined;
        if (!updated) return null;
        claim.row = updated; return claim;
      }));
    }
    return this.transaction(async () => {
      if (!(this.source instanceof DevelopmentStore)) return null;
      const store=this.source, nowMs=store.now();
      const job=store.database.prepare("SELECT * FROM jobs WHERE kind=? AND ((state='pending' AND due_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY due_at,id LIMIT 1").get(KIND,nowMs,nowMs) as unknown as JobRow | undefined;
      if (!job) return null;
      store.database.prepare("UPDATE jobs SET state='leased',attempts=attempts+1,lease_until=?,lease_token_hash=? WHERE id=?").run(nowMs+LEASE_MS,digest(leaseToken),job.id);
      const row=store.database.prepare('SELECT * FROM report_exports WHERE job_id=?').get(job.id) as unknown as ExportRow | undefined;
      if (!row) { store.database.prepare("UPDATE jobs SET state='failed',lease_until=NULL,last_error_code='EXPORT_NOT_FOUND' WHERE id=?").run(job.id); return null; }
      const preparation=store.document<{club:{id:string}}>(row.team_id,row.season_id,'preparation');
      const claim:ExportClaim={row,jobId:job.id,attempt:job.attempts+1,leaseToken,clubId:preparation.club.id,teamId:row.team_id,seasonId:row.season_id,claimedAtMs:nowMs,claimedMonotonicMs:performance.now()};
      if (['ready','failed','expired'].includes(row.status)) { store.database.prepare('UPDATE jobs SET state=?,lease_until=NULL,last_error_code=? WHERE id=?').run(row.status==='ready'?'completed':'failed',row.failure_code,job.id); return null; }
      if (claim.attempt>3) { await this.fail(claim,'EXPORT_RETRY_LIMIT',true); return null; }
      store.database.prepare("UPDATE report_exports SET status='working',version=version+1 WHERE id=?").run(row.id);
      claim.row={...row,status:'working',version:row.version+1}; return claim;
    });
  }
  async withClaim<T>(claim: ExportClaim, work: () => Promise<T>): Promise<T> {
    if (!(this.source instanceof PostgresStore)) return work();
    return this.source.db.withContext({ kind:'worker_job',jobId:claim.jobId,leaseToken:claim.leaseToken,clubId:claim.clubId,teamId:claim.teamId,seasonId:claim.seasonId,nowMs:Math.floor(claim.claimedAtMs+performance.now()-claim.claimedMonotonicMs) },work);
  }
  private async owns(claim: ExportClaim): Promise<boolean> {
    const nowMs=await this.now();
    const row=this.source instanceof PostgresStore
      ? await this.source.one('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[claim.jobId]) as unknown as JobRow | undefined
      : this.source.database.prepare('SELECT * FROM jobs WHERE id=?').get(claim.jobId) as unknown as JobRow | undefined;
    return Boolean(row && row.state==='leased' && row.attempts===claim.attempt && row.lease_until!==null && row.lease_until>nowMs && row.lease_token_hash===digest(claim.leaseToken));
  }
  private async now():Promise<number>{
    if(this.source instanceof DevelopmentStore)return this.source.now();
    const row=await this.source.one('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms');
    if(!Number.isSafeInteger(row?.now_ms))throw new Error('EXPORT_CLOCK_UNAVAILABLE');return Number(row!.now_ms);
  }
  async finish(claim: ExportClaim, update: { artifactCiphertext: string; artifactSha256: string; generatedAtMs: number }): Promise<boolean> {
    return this.transaction(async()=>{
      if(!await this.owns(claim))return false;
      const row=await this.get(claim.row.id);if(!row||row.status!=='working')return false;
      const current=await this.current(row);
      if(!current.allowed||current.sourceFingerprint!==row.source_fingerprint||current.nowMs>=row.expires_at){await this.fail(claim,current.nowMs>=row.expires_at?'EXPORT_EXPIRED':'EXPORT_SOURCE_CHANGED',true);return false;}
      if(!/^[a-f0-9]{64}$/.test(update.artifactSha256)||!Number.isSafeInteger(update.generatedAtMs)||update.generatedAtMs<row.created_at||update.generatedAtMs>current.nowMs+30_000)throw new Error('EXPORT_ARTIFACT_INVALID');
      if(this.source instanceof PostgresStore){
        const changed=await this.source.execute("UPDATE report_exports SET status='ready',artifact_ciphertext=$1,artifact_sha256=$2,generated_at=$3,snapshot_ciphertext=NULL,failure_code=NULL,version=version+1 WHERE id=$4 AND status='working'",[update.artifactCiphertext,update.artifactSha256,update.generatedAtMs,row.id]);
        if(!changed.changes)return false;
        await this.source.execute("UPDATE jobs SET state='completed',lease_until=NULL,last_error_code=NULL WHERE id=$1 AND attempts=$2",[claim.jobId,claim.attempt]);
      }else{
        this.source.database.prepare("UPDATE report_exports SET status='ready',artifact_ciphertext=?,artifact_sha256=?,generated_at=?,snapshot_ciphertext=NULL,failure_code=NULL,version=version+1 WHERE id=? AND status='working'").run(update.artifactCiphertext,update.artifactSha256,update.generatedAtMs,row.id);
        this.source.database.prepare("UPDATE jobs SET state='completed',lease_until=NULL,last_error_code=NULL WHERE id=? AND attempts=?").run(claim.jobId,claim.attempt);
      }return true;
    });
  }
  async fail(claim:ExportClaim,code:string,terminal:boolean):Promise<boolean>{
    return this.transaction(async()=>{
      if(!await this.owns(claim))return false;
      const row=await this.get(claim.row.id);if(!row||!['queued','working'].includes(row.status))return false;
      const nowMs=await this.now(),expired=nowMs>=row.expires_at,done=terminal||expired||claim.attempt>=3,safeCode=expired?'EXPORT_EXPIRED':failureCode(code);
      const status=expired?'expired':done?'failed':'queued';
      if(this.source instanceof PostgresStore){
        await this.source.execute('UPDATE report_exports SET status=$1,failure_code=$2,snapshot_ciphertext=CASE WHEN $3 THEN NULL ELSE snapshot_ciphertext END,artifact_ciphertext=NULL,artifact_sha256=NULL,version=version+1 WHERE id=$4',[status,safeCode,done,row.id]);
        await this.source.execute('UPDATE jobs SET state=$1,due_at=$2,lease_until=NULL,last_error_code=$3 WHERE id=$4 AND attempts=$5',[done?'failed':'pending',nowMs+Math.min(60_000,1000*2**claim.attempt),safeCode,claim.jobId,claim.attempt]);
      }else{
        this.source.database.prepare('UPDATE report_exports SET status=?,failure_code=?,snapshot_ciphertext=CASE WHEN ? THEN NULL ELSE snapshot_ciphertext END,artifact_ciphertext=NULL,artifact_sha256=NULL,version=version+1 WHERE id=?').run(status,safeCode,Number(done),row.id);
        this.source.database.prepare('UPDATE jobs SET state=?,due_at=?,lease_until=NULL,last_error_code=? WHERE id=? AND attempts=?').run(done?'failed':'pending',nowMs+Math.min(60_000,1000*2**claim.attempt),safeCode,claim.jobId,claim.attempt);
      }return true;
    });
  }
  async expire(row:ExportRow):Promise<void>{await this.clear(row,'expired','EXPORT_EXPIRED');}
  async invalidate(row:ExportRow,code:string):Promise<void>{await this.clear(row,'failed',failureCode(code));}
  private async clear(row:ExportRow,status:'failed'|'expired',code:string):Promise<void>{
    await this.transaction(async()=>{
      if(status==='expired'&&row.expires_at>await this.now())return;
      if(this.source instanceof PostgresStore)await this.source.execute('UPDATE report_exports SET status=$1,failure_code=$2,snapshot_ciphertext=NULL,artifact_ciphertext=NULL,artifact_sha256=NULL,version=version+1 WHERE id=$3 AND status<>\'expired\'',[status,code,row.id]);
      else{
        this.source.database.prepare('UPDATE report_exports SET status=?,failure_code=?,snapshot_ciphertext=NULL,artifact_ciphertext=NULL,artifact_sha256=NULL,version=version+1 WHERE id=? AND status<>\'expired\'').run(status,code,row.id);
        this.source.database.prepare("UPDATE jobs SET state='failed',lease_until=NULL,last_error_code=? WHERE id=? AND state IN('pending','leased')").run(code,row.job_id);
      }
    });
  }
  async purgeExpired():Promise<number>{
    if(this.source instanceof PostgresStore){
      const store=this.source;return store.db.withContext({kind:'worker_claim',jobKind:KIND,nowMs:Date.now()},()=>this.transaction(async()=>Number((await store.one('SELECT longball.purge_report_exports() AS changed'))?.changed??0)));
    }
    return this.transaction(async()=>{
      if(!(this.source instanceof DevelopmentStore))return 0;
      const rows=this.source.database.prepare("SELECT * FROM report_exports WHERE expires_at<=? AND status<>'expired' ORDER BY expires_at,id LIMIT 20").all(this.source.now()) as unknown as ExportRow[];
      for(const row of rows)await this.clear(row,'expired','EXPORT_EXPIRED');return rows.length;
    });
  }
}
