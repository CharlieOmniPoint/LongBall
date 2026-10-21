import { PostgresStore } from '../apps/api/src/postgres-store';
import { readDatabaseUrl } from '../apps/api/src/database-config';
import { SYNTHETIC_IDS } from '../apps/api/src/store';
import { runDuePostgresJobs } from '../apps/worker/src/postgres-jobs';
import { runDueTeamNotifications } from '../apps/worker/src/notification-jobs';
import type { CommunityState } from '../packages/application/src/community';

/** Disposable private runtime fixture only. This command never contacts a push provider. */
async function prove():Promise<void>{
  if(process.env.LONGBALL_RUNTIME_FIXTURE!=='1')throw new Error('EXPLICIT_DISPOSABLE_FIXTURE_REQUIRED');
  const apiUrl=readDatabaseUrl(process.env),workerUrl=readDatabaseUrl(process.env,'LONGBALL_WORKER_DATABASE_URL');
  if(!apiUrl||!workerUrl)throw new Error('TWO_RESTRICTED_DATABASE_SELECTORS_REQUIRED');
  let nowMs=Date.now();
  const api=await PostgresStore.open(apiUrl,()=>nowMs,{migrationMode:'verify'});
  const worker=await PostgresStore.open(workerUrl,()=>nowMs,{migrationMode:'verify'});
  try{
    const apiRole=await api.one('SELECT current_user AS role'),workerRole=await worker.one('SELECT current_user AS role');
    if(apiRole?.role!=='longball_api'||workerRole?.role!=='longball_worker')throw new Error('RESTRICTED_RUNTIME_ROLES_REQUIRED');
    await api.seedSynthetic();
    const scope=SYNTHETIC_IDS;
    const community=await api.document<CommunityState>(scope.teamId,scope.seasonId,'community');
    const match=community.matches.find(item=>item.finishQuality==='trusted'&&item.actualFullTimeAtMs!==null&&!community.awards.some(award=>award.matchId===item.id));
    if(!match)throw new Error('FRESH_FICTIONAL_AWARD_FIXTURE_REQUIRED');
    nowMs=match.actualFullTimeAtMs!+3_600_001;
    const manager=await api.principal({issuer:'urn:longball:synthetic',subject:'synthetic-account-manager',strongAuth:true,authenticatedAt:nowMs});
    await api.transaction(()=>api.communityCommand(manager,scope.teamId,scope.seasonId,{id:'runtime-worker-explicit-cutoff',type:'award.cutoffConfigured',matchId:match.id,minutesAfterFullTime:1}));
    const awards=await runDuePostgresJobs(worker,nowMs);
    if(awards.completed!==1||awards.failed!==0||awards.retried!==0)throw new Error('ACTUAL_AWARD_WORKER_REQUIRED');
    const sealed=await api.document<CommunityState>(scope.teamId,scope.seasonId,'community');
    const award=sealed.awards.find(item=>item.matchId===match.id);
    if(!award||!award.deadlineMissed||award.finalisationDeadlineAtMs!==match.actualFullTimeAtMs!+3_600_000)throw new Error('UNCHANGED_ORIGINAL_DEADLINE_REQUIRED');
    const notifications=await runDueTeamNotifications(worker,{now:()=>nowMs,maximum:100});
    if(notifications.accepted!==0||notifications.blocked<1)throw new Error('UNCONFIGURED_PROVIDER_MUST_REMAIN_BLOCKED');
    let workerDdlDenied=false,workerAccountWriteDenied=false,apiEvidenceDeleteDenied=false;
    try{await worker.db.query('CREATE TABLE longball.forbidden_worker_role_probe(id integer)');}catch(error){workerDdlDenied=Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='42501');}
    try{await worker.db.query('UPDATE accounts SET adult_verified=1 WHERE false');}catch(error){workerAccountWriteDenied=Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='42501');}
    try{await api.db.query('DELETE FROM events WHERE false');}catch(error){apiEvidenceDeleteDenied=Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='42501');}
    if(!workerDdlDenied||!workerAccountWriteDenied||!apiEvidenceDeleteDenied)throw new Error('RESTRICTED_DATABASE_PERMISSIONS_REQUIRED');
    console.log(JSON.stringify({kind:'longball-worker-role-proof',backend:'postgresql',awards,notifications,workerDdlDenied,workerAccountWriteDenied,apiEvidenceDeleteDenied,actualPushDelivered:false}));
  }finally{await worker.close();await api.close();}
}
await prove().catch(error=>{console.error(JSON.stringify({kind:'longball-worker-role-proof',status:'failed',code:error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.message:'UNKNOWN'}));process.exitCode=1;});
