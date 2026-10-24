/** Disposable fictional HTTP fixture for the Match Centre page-continuation review. */
import { createApi } from '../apps/api/src/server';
import { SYNTHETIC_IDS } from '../apps/api/src/store';
import type { MatchConfig } from '../packages/domain/src/index';
if (process.env.NODE_ENV === 'production') throw new Error('The pagination fixture is fictional development data only.');
const databasePath = process.env.LONGBALL_PAGINATION_DATABASE;
if (!databasePath || !databasePath.startsWith('.local/match-pagination/')) throw new Error('Choose a fresh isolated pagination fixture database under .local/match-pagination.');
const port = Number(process.env.LONGBALL_PAGINATION_PORT ?? '4391');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose an explicit local review port.');
const api = createApi({ databasePath, syntheticAuth: true, mediaDirectory: `${databasePath}-media`, allowedOrigins: [process.env.LONGBALL_PAGINATION_ORIGIN ?? 'http://127.0.0.1:4390'] });
const config = JSON.parse(api.store.match(SYNTHETIC_IDS.matchId).config_json) as MatchConfig;
for (let i = 0; i < 107; i++) api.store.insertMatch({ ...config, matchId: `page-match-${String(i).padStart(3, '0')}`, fixture: { opponent: `Fictional page opponent ${i}`, playedDate: '2026-10-24', kickoff: null, homeAway: 'home', teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, teamName: 'Roma U10', clubName: 'Richmond Rovers' } }, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
api.server.listen(port, '127.0.0.1', () => { console.log(`Fictional pagination API ready on 127.0.0.1:${port};108 isolated service snapshots.`); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { api.server.closeAllConnections(); void api.close().then(() => process.exit(0)); });
