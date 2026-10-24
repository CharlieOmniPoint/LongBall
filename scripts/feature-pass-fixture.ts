/** Disposable Node-owned QA fixture. Never used by the public application or a production database. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createMatch, reduceMatch, type MatchEvent } from '../packages/domain/src/index';
import { createDemoCompletedMatches } from '../packages/application/src/demo-season';
import { londonDateKey } from '../packages/application/src/uk-display';
import { matchFeedbackClosesAt } from '../packages/application/src/match-feedback';
import { DevelopmentStore, SYNTHETIC_IDS } from '../apps/api/src/store';

assert.equal(process.env.LONGBALL_FEATURE_REVIEW_FIXTURE, '1', 'Explicit disposable feature review fixture selection is required.');
const databasePath = resolve(process.argv[2] ?? ''), manifestPath = resolve(process.argv[3] ?? '');
assert(dirname(databasePath).startsWith(resolve(tmpdir()) + sep) && basename(dirname(databasePath)).startsWith('longball-feature-pass-qa-'), 'Use only this runner’s new private temporary directory.');
assert.equal(dirname(manifestPath), dirname(databasePath), 'Fixture metadata must remain in its owned temporary directory.');
assert(!existsSync(databasePath), 'Never reuse or reset a database to obtain passing evidence.');
const store = new DevelopmentStore(databasePath);
try {
  store.seedSynthetic({ demoSharing: true });
  const source = createDemoCompletedMatches()[0];
  assert(source?.eventHistory?.length && source.status === 'completed', 'The owned source fixture must have actual reducer-generated completed play.');
  const matchId = 'qa-feature-feedback-completed', completedAtMs = Date.now() - 1000;
  assert(matchFeedbackClosesAt(completedAtMs) - Date.now() >= 300_000, 'The actual London-day feedback window is too close to midnight for this review. Retry after midnight without changing the service clock.');
  const events = source.eventHistory!;
  const firstTick = Math.min(...events.map(event => event.sample.monotonicMs));
  const lastTick = Math.max(...events.map(event => event.sample.monotonicMs));
  const startAtMs = completedAtMs - (lastTick - firstTick);
  const kickoff = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(startAtMs);
  const config = { ...structuredClone(source.config), matchId, fixture: { ...source.config.fixture!, opponent: 'Feature Review XI', playedDate: londonDateKey(startAtMs), kickoff } };
  let state = createMatch(config);
  for (const [index, event] of events.entries()) {
    const elapsed = event.sample.monotonicMs - firstTick;
    state = reduceMatch(state, { ...structuredClone(event), id: `${matchId}-event-${index + 1}`, sample: { monotonicMs: elapsed, sessionId: 'qa-feature-feedback-continuity', wallTimeMs: startAtMs + elapsed } } as MatchEvent);
  }
  assert.equal(state.status, 'completed');
  assert.equal(state.completedAtMs, completedAtMs);
  const selectedPlayerIds = [...state.config.selectedPlayerIds];
  const presentPlayerIds = selectedPlayerIds.filter(id => state.attendance[id] === 'present');
  const playedPlayerIds = selectedPlayerIds.filter(id => state.intervals.some(interval => interval.playerId === id && interval.state === 'playing' && interval.endMs > interval.startMs));
  assert(playedPlayerIds.includes('synthetic-player-01'), 'The player review account must have actual accepted positive playing intervals.');
  const community = store.communityState(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
  const context = community.matches.find(match => match.id === source.config.matchId);
  assert(context, 'Use an existing complete community fixture shape.');
  community.matches.push({ ...structuredClone(context), id: matchId, label: 'Roma v Feature Review XI', playedAtMs: startAtMs, actualFullTimeAtMs: completedAtMs, finishQuality: 'trusted', selectedPlayerIds, presentPlayerIds, playedPlayerIds, voteCutoffAtMs: completedAtMs + 45 * 60_000, finalisationDeadlineAtMs: completedAtMs + 60 * 60_000, cutoffSource: 'explicit_fictional_setting' });
  store.transaction(() => {
    store.insertMatch(config, SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId);
    store.database.prepare('UPDATE matches SET state_json=?,last_sync_at=? WHERE id=?').run(JSON.stringify(state), completedAtMs, matchId);
    store.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', community);
  });
  await writeFile(manifestPath, JSON.stringify({ matchId, completedAtMs, closesAtMs: matchFeedbackClosesAt(completedAtMs), playedPlayerIds, method: 'Fresh isolated SQLite fixture; full accepted match replay through the actual reducer, with a deliberately trusted Node-owned completion anchor at actual Node time. No browser-clock or production-authority claim.' }) + '\n', { mode: 0o600 });
} finally { store.close(); }
