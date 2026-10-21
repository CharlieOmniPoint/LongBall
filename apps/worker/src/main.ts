import { DevelopmentStore } from '../../api/src/store';
import { runDueJobs } from './jobs';
import { PostgresStore } from '../../api/src/postgres-store';
import { runDuePostgresJobs } from './postgres-jobs';
import { readDatabaseUrl } from '../../api/src/database-config';
import { runDueTeamNotifications } from './notification-jobs';

const connectionString=readDatabaseUrl(process.env);
if (!connectionString && process.env.LONGBALL_SYNTHETIC_AUTH!=='1') throw new Error('Configure PostgreSQL or explicit fictional SQLite mode for the worker.');
const migrationMode=process.env.LONGBALL_DATABASE_MIGRATION_MODE??(process.env.LONGBALL_SYNTHETIC_AUTH==='1'?'apply':'verify');
if(!['apply','verify'].includes(migrationMode)||process.env.NODE_ENV==='production'&&migrationMode!=='verify')throw new Error('The production worker verifies schemas; use the dedicated operator migration command.');
const store=connectionString?await PostgresStore.open(connectionString,Date.now,{migrationMode:migrationMode as 'apply'|'verify'}):new DevelopmentStore(process.env.LONGBALL_API_DATABASE??'.local/api/longball.sqlite');
let running=false;
const run = async () => { if(running)return;running=true;try{const result=store instanceof PostgresStore?await runDuePostgresJobs(store):runDueJobs(store);const notifications=await runDueTeamNotifications(store);if(result.completed||result.retried||result.failed||Object.values(notifications).some(Boolean))console.log(JSON.stringify({worker:connectionString?'longball-postgresql':'longball-fictional',...result,notifications}));}finally{running=false;} };
await run();
if (process.argv.includes('--once')) await store.close();
else {
  const timer = setInterval(()=>{void run().catch(()=>console.error('LONGBALL_WORKER_CYCLE_FAILED'));},5_000);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(timer);void Promise.resolve(store.close()).then(()=>process.exit(0));});
}
