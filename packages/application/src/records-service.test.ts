import { describe, expect, it } from 'vitest';
import { createMatch, reduceMatch, type MatchEvent, type MatchState } from '@longball/domain';
import { romaFixture } from '@longball/testing';
import type { Membership, Principal } from './access';
import { createRecordsSeed, type HistoricalResultInput, type RecordsCommand } from './records';
import { applyRecordsServiceCommand, parseHistoricalResultInput, recordsServiceExport, recordsServiceView, type RecordsServiceInput } from './records-service';
import { createCommunityState, getCommunityView } from './community';
import type { ReportCommunitySource } from './report-community';
import { createPreparationState } from './preparation';

const now = Date.parse('2026-10-21T12:00:00Z');
function fixture(): RecordsServiceInput {
  const state = createRecordsSeed();
  const principal: Principal = { accountId: 'manager-1', issuer: 'https://issuer.example', subject: 'manager-subject', identityClassification: 'adult_individual', adultVerified: true, strongAuth: true, authenticatedAt: now, status: 'active' };
  const memberships: Membership[] = [{ accountId: principal.accountId, teamId: state.teamId, seasonId: state.seasonId, role: 'manager' }];
  return { state, principal, memberships, nowMs: now, acceptedMatches: [] };
}
function inputFrom(record: HistoricalResultInput): HistoricalResultInput {
  return { playedDate: record.playedDate, recordedKickoff: record.recordedKickoff, sameDayOrder: record.sameDayOrder, opponent: record.opponent, homeAway: record.homeAway, fixtureClass: record.fixtureClass, status: record.status, specialOutcome: record.specialOutcome, finalScore: record.finalScore, halfTimeScore: record.halfTimeScore, goals: record.goals };
}
function complete(): MatchState {
  const scope = fixture().state;
  let match = createMatch({ matchId: scope.liveMatch.matchId, players: romaFixture.players, selectedPlayerIds: romaFixture.players.slice(0, 9).map(player => player.id), pitchPlaces: 7, plannedHalfDurationMs: 1_500_000, fixedKeeperId: romaFixture.players[0].id,
    fixture: { opponent: scope.liveMatch.opponent, playedDate: scope.liveMatch.playedDate, kickoff: null, homeAway: 'home', teamId: scope.teamId, seasonId: scope.seasonId, teamName: 'Roma', clubName: 'Fictional club' } });
  let id = 0;
  const send = (command: object, ms: number) => { match = reduceMatch(match, { ...command, id: `accepted-event-${++id}`, actorId: 'verified-server-account', sample: { monotonicMs: ms, sessionId: 'accepted-clock', wallTimeMs: now + ms } } as MatchEvent); };
  for (const playerId of match.config.selectedPlayerIds) send({ type: 'attendance.recorded', playerId, status: 'present' }, 0);
  send({ type: 'lineup.staged', lineup: match.config.selectedPlayerIds.slice(0, 7).map((playerId, index) => ({ playerId, slotId: `slot-${index}`, position: index === 0 ? 'GK' : 'CM' })) }, 0);
  send({ type: 'half.started' }, 0); send({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: match.config.selectedPlayerIds[1] }, 30_000); send({ type: 'half.ended' }, 60_000);
  send({ type: 'half.started' }, 120_000); send({ type: 'half.ended' }, 180_000);
  return match;
}
function withAccepted(): RecordsServiceInput {
  const context = fixture();
  return { ...context, acceptedMatches: [{ teamId: context.state.teamId, seasonId: context.state.seasonId, match: complete() }] };
}
function audience(context: RecordsServiceInput, role: 'player' | 'spectator', accountId = role): RecordsServiceInput {
  return { ...context, principal: { ...context.principal, accountId, subject: accountId, identityClassification: role === 'player' ? 'child_shared' : 'adult_individual', adultVerified: false, strongAuth: false }, memberships: [{ accountId, teamId: context.state.teamId, seasonId: context.state.seasonId, role, ...(role === 'player' ? { playerId: context.state.players[0].id } : {}), expiresAt: now + 60_000 }] };
}
describe('connected records service boundaries', () => {
  it('projects each authorised accepted fixture without switching report context or approving sharing', () => {
    const context = withAccepted(), second = structuredClone(context.acceptedMatches[0].match);
    second.config.matchId = 'synthetic-second-accepted-match';
    second.config.fixture!.opponent = 'Fictional second opposition';
    const before = structuredClone(context.state);
    const input = { ...context, acceptedMatches: [...context.acceptedMatches, { teamId: context.state.teamId, seasonId: context.state.seasonId, match: second }, { teamId: 'other-team', seasonId: context.state.seasonId, match: { ...second, config: { ...second.config, matchId: 'private-other-team' } } }] };
    const report = recordsServiceView(input).matches.find(value => value.matchId === second.config.matchId)!;
    expect(report).toMatchObject({ score: { for: 1, against: 0 }, opponent: 'Fictional second opposition', sourceMatchRevision: second.revision });
    expect(report.goals).toHaveLength(1);
    expect(report.goals[0].scorerLabel).toBeTruthy();
    expect(recordsServiceView(input).matches.some(value => value.matchId === 'private-other-team')).toBe(false);
    for (const role of ['player', 'spectator'] as const) {
      const filtered = recordsServiceView(audience(input, role)).matches.find(value => value.matchId === second.config.matchId)!;
      expect(filtered).toMatchObject({ score: null, goals: [] });
    }
    expect(context.state).toEqual(before);
  });
  it('joins only the current filtered final award/album into report and export without private ballot or pending media fields', () => {
    const context = fixture(), state = createCommunityState(now), originalMatchId = state.matches[0].id, matchId = context.state.results[0].id;
    state.matches[0].id = matchId; state.photos.forEach(photo => { if (photo.matchId === originalMatchId) photo.matchId = matchId; });
    state.awards.push({ matchId, winnerPlayerIds: ['synthetic-player-01'], result: 'winners', voteCutoffAtMs: now - 60_000, finalisationDeadlineAtMs: now, finalisedAtMs: now - 30_000, deadlineMissed: false });
    const community: ReportCommunitySource = { accountId: context.principal.accountId, teamId: context.state.teamId, seasonId: context.state.seasonId, audience: 'manager', playerId: null, revision: 7, view: getCommunityView(state, { accountId: 'synthetic-account-manager', teamId: context.state.teamId, seasonId: context.state.seasonId, role: 'manager' }, now) };
    const report = recordsServiceView({ ...context, community }).matches.find(report => report.matchId === matchId)!;
    expect(report.award).toMatchObject({ result: 'winners', winnerLabels: ['Thomas Arnold'] }); expect(report.publishedAlbum).toEqual({ matchId, photoCount: 1 });
    const exported = recordsServiceExport({ ...context, community, request: { kind: 'match', matchId, format: 'json' } });
    expect(JSON.parse(exported.body).matches[0].award.winnerLabels).toEqual(['Thomas Arnold']);
    for (const forbidden of ['ownChoice', 'candidates', 'reviewQueue', 'submissions', 'synthetic-pending-ball']) expect(exported.body).not.toContain(forbidden);
    const player = audience(context, 'player');
    const withheld = recordsServiceView({ ...player, community: { ...community, accountId: player.principal.accountId, audience: 'player', playerId: player.memberships[0].playerId! } }).matches.find(report => report.matchId === matchId)!;
    expect(withheld).toMatchObject({ communityStatus: 'withheld', award: null, publishedAlbum: null });
  });
  it('corrects known historical results with bound server time, recomputed points and unchanged unknown interval evidence', () => {
    const context = fixture(), record = context.state.results[1];
    const command: RecordsCommand = { type: 'historical.correct', commandId: 'historical-correction', actor: 'spectator', at: '1900-01-01T00:00:00Z', recordId: record.id, expectedRevision: record.revision, input: { ...inputFrom(record), finalScore: { for: 2, against: 3 } }, reason: 'Checked original results sheet.' };
    const state = applyRecordsServiceCommand({ ...context, command });
    expect(recordsServiceView({ ...context, state }).results.totals?.points).toBe(3);
    expect(state.audit.at(-1)).toMatchObject({ at: new Date(now).toISOString(), before: { finalScore: { for: 2, against: 2 } }, after: { finalScore: { for: 2, against: 3 }, participation: null, attendance: null, awardStatus: 'not_recorded' } });
    expect(context.state.results[1].finalScore).toEqual({ for: 2, against: 2 });
    expect(() => applyRecordsServiceCommand({ ...context, state, command: { ...command, commandId: 'stale-correction' } })).toThrow('latest revision');
  });
  it('rejects unknown historical/private fields and invalid enums rather than broadcasting arbitrary submitted data', () => {
    const base = inputFrom(fixture().state.results[0]);
    for (const patch of [{ injuryReason: 'private' }, { status: 'anything' }, { fixtureClass: 'approved' }, { goals: [{ ...base.goals[0], contact: 'private' }] }, { halfTimeScore: { for: 1, against: 0, private: 'no' } }]) expect(() => parseHistoricalResultInput({ ...base, ...patch })).toThrow();
    expect(parseHistoricalResultInput(base)).toEqual(base);
  });
  it('binds context and archive to accepted fixture scope/revision and ignores forged state payloads', () => {
    const context = withAccepted(), match = context.acceptedMatches[0].match;
    expect(() => applyRecordsServiceCommand({ ...context, command: { commandId: 'forged-context', actor: 'manager', at: new Date(now).toISOString(), type: 'live.context.set', details: { ...context.state.liveMatch, opponent: 'Invented opposition' } } })).toThrow('accepted fixture');
    expect(() => applyRecordsServiceCommand({ ...context, command: { type: 'live.archive', commandId: 'stale-archive', matchId: match.config.matchId, expectedSourceMatchRevision: match.revision - 1 } })).toThrow('changed');
    const forged = structuredClone(match); forged.score.for = 99; forged.intervals = [];
    const state = applyRecordsServiceCommand({ ...context, command: { type: 'live.archive', commandId: 'accepted-archive', actor: 'manager', at: new Date(now).toISOString(), match: forged } });
    const saved = state.results.find(record => record.id === match.config.matchId)!;
    expect(saved.finalScore).toEqual({ for: 1, against: 0 }); expect(saved.participation?.[0].intervals).not.toEqual([]);
    expect(match.completedAtMs).toBe(saved.sourceMatchRevision === match.revision ? complete().completedAtMs : null);
    expect(() => applyRecordsServiceCommand({ ...context, acceptedMatches: [{ ...context.acceptedMatches[0], teamId: 'other-team' }], command: { type: 'live.archive', commandId: 'cross-team', matchId: match.config.matchId, expectedSourceMatchRevision: match.revision } })).toThrow('outside');
  });
  it('reclassification invalidates prior publication and can rearchive unchanged accepted minutes with audit', () => {
    const context = withAccepted(), match = context.acceptedMatches[0].match;
    let state = applyRecordsServiceCommand({ ...context, command: { type: 'live.archive', commandId: 'archive-before-classification', matchId: match.config.matchId, expectedSourceMatchRevision: match.revision } });
    const archived = state.results.find(record => record.id === match.config.matchId)!;
    archived.publication = { id: 'operator-existing-fixture-policy', version: 2, fixtureClass: archived.fixtureClass, confirmed: true, confirmationReference: 'operator evidence', allowedRoles: ['spectator'] };
    state = applyRecordsServiceCommand({ ...context, state, command: { type: 'live.context.set', commandId: 'new-classification', actor: 'manager', at: new Date(now).toISOString(), details: { ...state.liveMatch, fixtureClass: 'friendly' } } });
    state = applyRecordsServiceCommand({ ...context, state, command: { type: 'live.archive', commandId: 'rearchive-classification', matchId: match.config.matchId, expectedSourceMatchRevision: match.revision, reason: 'The fixture classification was corrected.' } });
    const updated = state.results.find(record => record.id === match.config.matchId)!;
    expect(updated.classificationVersion).toBe(2); expect(updated.publication.confirmed).toBe(false); expect(updated.participation).toEqual(archived.participation); expect(updated.sourceMatchRevision).toBe(match.revision);
    expect(recordsServiceView(audience({ ...context, state }, 'spectator')).matches.find(report => report.matchId === match.config.matchId)?.score).toBeNull();
  });
  it('allows audited fairness exception notes but not caller-created attendance or self-approved Q21', () => {
    const context = withAccepted(), match = context.acceptedMatches[0].match;
    let state = applyRecordsServiceCommand({ ...context, command: { type: 'live.archive', commandId: 'archive-note', matchId: match.config.matchId, expectedSourceMatchRevision: match.revision } });
    const record = state.results.find(item => item.id === match.config.matchId)!;
    const player = record.participation!.find(item => item.target && !item.target.withinBand)!;
    state = applyRecordsServiceCommand({ ...context, state, command: { type: 'participation.exception.noted', commandId: 'explain-exception', actor: 'manager', at: new Date(now).toISOString(), recordId: record.id, expectedRevision: record.revision, playerId: player.playerId, reason: 'Manager reviewed the actual interval evidence.' } });
    expect(state.results.find(item => item.id === record.id)?.participation?.find(item => item.playerId === player.playerId)?.target?.exceptionReason).toContain('actual interval');
    expect(() => applyRecordsServiceCommand({ ...context, command: { type: 'training.evidence.replace', commandId: 'invent-training', actor: 'manager', at: new Date(now).toISOString(), evidence: [] } })).toThrow('projected');
    expect(() => applyRecordsServiceCommand({ ...context, command: { type: 'publication.set', commandId: 'self-policy', actor: 'manager', at: new Date(now).toISOString(), recordId: record.id, expectedRevision: 1, reason: 'Self approval', policy: record.publication } })).toThrow('Independent');
  });
  it('returns manager editors only to the selected current manager role', () => {
    const context = fixture();
    expect(recordsServiceView(context)).toHaveProperty('editableState');
    const own = audience(context, 'player');
    const view = recordsServiceView(own);
    expect(view).not.toHaveProperty('editableState'); expect(view).not.toHaveProperty('activeMatch'); expect(view.participation.rows.map(row => row.playerId)).toEqual([context.state.players[0].id]);
    const dual = { ...context, memberships: [...context.memberships, { ...own.memberships[0], accountId: context.principal.accountId }], requestedRole: 'player' as const };
    expect(recordsServiceView(dual)).not.toHaveProperty('editableState');
    expect(() => recordsServiceView({ ...own, nowMs: now + 60_000 })).toThrow('unavailable');
  });
  it('exports current role-filtered JSON/CSV with metadata, unknowns and policy restrictions without raw state/audit/ballots', () => {
    const context = fixture(), own = audience(context, 'player');
    const exported = recordsServiceExport({ ...own, request: { kind: 'season', format: 'json', expectedProjectionVersion: own.state.revision } });
    const doc = JSON.parse(exported.body);
    expect(doc).toMatchObject({ teamId: context.state.teamId, seasonId: context.state.seasonId, audience: 'player', projectionVersion: context.state.revision, dataCoverage: { includesInventedHistoricalMinutes: false } });
    expect(doc.participation.rows.map((row: { playerId: string }) => row.playerId)).toEqual([context.state.players[0].id]);
    expect(exported.body).not.toContain('Ralph Barrett'); expect(doc.results.totals).toBeNull();
    for (const field of ['editableState', 'activeMatch', 'appliedCommands', 'ballots', 'audit']) expect(exported.body).not.toContain(`"${field}"`);
    const spectator = recordsServiceExport({ ...audience(context, 'spectator'), request: { kind: 'season', format: 'csv' } });
    expect(spectator.body).not.toContain('"participation",'); expect(spectator.body).not.toContain('Thomas Arnold'); expect(spectator.body).toContain('Scores are not shared');
    const single = JSON.parse(recordsServiceExport({ ...context, request: { kind: 'match', matchId: context.state.results[0].id, format: 'json' } }).body);
    expect(single.matches).toHaveLength(1); expect(single.matches[0].participation).toBeNull(); expect(single.matches[0].halfTimeScore).toBeNull(); expect(single.matches[0].goals[0].scorerLabel).toBe('Ralph Barrett');
  });
  it('adds only bounded current public preparation labels to JSON without changing legacy CSV shape or exposing another profile', () => {
    const context = audience(fixture(), 'player'), preparation = createPreparationState();
    const own = { ...context, preparation }, request = { kind: 'season' as const, format: 'json' as const };
    const exported = recordsServiceExport({ ...own, request }), document = JSON.parse(exported.body);
    expect(document).toMatchObject({ clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27' });
    expect(document.participation.rows.map((row: {playerId: string}) => row.playerId)).toEqual([context.state.players[0].id]);
    expect(exported.body).not.toContain('Ralph Barrett');
    for (const field of ['profiles', 'medicalNotes', 'ownPreferences', 'clubLogo', 'teamLogo']) expect(document).not.toHaveProperty(field);
    const renamed = { ...preparation, club: { ...preparation.club, name: 'Riverside Juniors' }, team: { ...preparation.team, name: 'Falcons', ageGroup: 'U11' }, seasons: preparation.seasons.map(season => season.id === context.state.seasonId ? { ...season, label: 'Autumn 2026' } : season) };
    const fresh = JSON.parse(recordsServiceExport({ ...context, preparation: renamed, request }).body);
    expect(fresh).toMatchObject({ clubName: 'Riverside Juniors', teamName: 'Falcons', ageGroup: 'U11', seasonLabel: 'Autumn 2026' });
    const csvRequest = { ...request, format: 'csv' as const };
    expect(recordsServiceExport({ ...context, preparation: renamed, request: csvRequest }).body).toBe(recordsServiceExport({ ...own, request: csvRequest }).body);
    const invalid = { ...preparation, club: { ...preparation.club, name: 'Private\nmetadata' }, team: { ...preparation.team, name: 'x'.repeat(151), ageGroup: '' } };
    expect(JSON.parse(recordsServiceExport({ ...context, preparation: invalid, request }).body)).toMatchObject({ clubName: null, teamName: null, ageGroup: null });
    expect(() => recordsServiceExport({ ...context, preparation: { ...preparation, team: { ...preparation.team, id: 'another-team' } }, request })).toThrow('outside this report scope');
    expect(() => recordsServiceExport({ ...context, preparation: { ...preparation, seasons: [] }, request })).toThrow('outside this report scope');
    expect(JSON.parse(recordsServiceExport({ ...context, request }).body)).not.toHaveProperty('clubName');
  });
  it('rejects stale exports and escaped spreadsheet formulas, and rechecks membership before rebuilding the body', () => {
    const context = fixture(), original = recordsServiceExport({ ...context, request: { kind: 'season', format: 'json' } });
    expect(() => recordsServiceExport({ ...context, state: { ...context.state, revision: 1 }, request: { kind: 'season', format: 'json', expectedProjectionVersion: 0 } })).toThrow('changed');
    expect(() => recordsServiceExport({ ...context, request: { kind: 'season', format: 'json', expectedPolicyFingerprint: `${original.policyFingerprint}-stale` } })).toThrow('changed');
    const spectator = audience(context, 'spectator');
    expect(() => recordsServiceExport({ ...spectator, memberships: [{ ...spectator.memberships[0], revokedAt: now }], request: { kind: 'season', format: 'json' } })).toThrow('unavailable');
    context.state.results[0].opponent = '=HYPERLINK("hostile")';
    const csv = recordsServiceExport({ ...context, request: { kind: 'match', matchId: context.state.results[0].id, format: 'csv' } });
    expect(csv.body).toContain("'=HYPERLINK"); expect(csv.body).toContain('Not recorded');
  });
});
