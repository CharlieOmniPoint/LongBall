import { DevelopmentStore } from '../../api/src/store';
import { runDueJobs } from './jobs';

const store = new DevelopmentStore(process.env.LONGBALL_API_DATABASE ?? '.local/api/longball.sqlite');
const run = () => { const result = runDueJobs(store); if (result.completed || result.retried || result.failed) console.log(JSON.stringify({ worker: 'longball-development', ...result })); };
run();
if (process.argv.includes('--once')) store.close();
else {
  const timer = setInterval(run, 5_000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(timer); store.close(); process.exit(0); });
}
