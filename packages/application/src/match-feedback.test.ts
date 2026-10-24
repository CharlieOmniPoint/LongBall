import { describe, expect, it } from 'vitest';
import { assertMatchFeedbackView, matchFeedbackClosesAt, matchFeedbackWindow, parseMatchFeedbackCommand } from './match-feedback';

const input = { id: 'feedback-request-1', type: 'feedback.saved', matchId: 'accepted-game', expectedRevision: 0, rating: 4, text: null };
describe('private post-game feedback contract and London day boundary', () => {
  it('uses the next local midnight through GMT, BST and both DST transition days', () => {
    for (const [finish, expected] of [
      ['2026-01-15T23:59:59.999Z', '2026-01-16T00:00:00.000Z'],
      ['2026-07-15T20:00:00.000Z', '2026-07-15T23:00:00.000Z'],
      ['2026-03-29T00:30:00.000Z', '2026-03-29T23:00:00.000Z'],
      ['2026-10-25T00:30:00.000Z', '2026-10-26T00:00:00.000Z'],
      ['2026-10-25T01:30:00.000Z', '2026-10-26T00:00:00.000Z'],
    ]) expect(new Date(matchFeedbackClosesAt(Date.parse(finish))).toISOString()).toBe(expected);
  });
  it('accepts the final millisecond and closes at midnight without extending by 24 hours', () => {
    const finish = Date.parse('2026-03-29T00:30:00Z'), cutoff = matchFeedbackClosesAt(finish);
    expect(matchFeedbackWindow(finish, cutoff - 1)).toBe('open');
    expect(matchFeedbackWindow(finish, cutoff)).toBe('closed');
    expect(() => matchFeedbackWindow(finish, finish - 1)).toThrow('completion time');
    expect(() => matchFeedbackClosesAt(NaN)).toThrow('verified');
  });
  it('validates exact integer ratings, Unicode code points and own-target-free command fields', () => {
    expect(parseMatchFeedbackCommand({ ...input, text: '🙂'.repeat(256) }).text).toHaveLength(512);
    expect(parseMatchFeedbackCommand({ ...input, text: '   ' }).text).toBeNull();
    for (const change of [{ rating: 0 }, { rating: 6 }, { rating: 1.5 }, { text: '🙂'.repeat(257) }, { text: 'x'.repeat(257) }, { text: 'bad\u0000text' }, { playerId: 'another-child' }, { completedAtMs: 1 }, { expectedRevision: -1 }]) expect(() => parseMatchFeedbackCommand({ ...input, ...change })).toThrow();
  });
  it('accepts canonical match entity punctuation without broadening command identifiers', () => {
    const binding = { accountId: 'own-account', teamId: 'roma', seasonId: '2026', role: 'manager' as const };
    const match = { matchId: 'match.2026:roma_u10-1', label: 'Roma v Milan', playedDate: '2026-10-24', completedAtMs: 10, closesAtMs: 1000, status: 'open', eligible: false, canEdit: false, own: null, entries: [] };
    const view = { kind: 'match-feedback', accountId: binding.accountId, playerId: null, teamId: binding.teamId, seasonId: binding.seasonId, audience: 'manager', serverNowMs: 100, matches: [match] };
    expect(parseMatchFeedbackCommand({ ...input, matchId: match.matchId }).matchId).toBe(match.matchId);
    expect(() => assertMatchFeedbackView(view, binding)).not.toThrow();
    for (const matchId of ['', 'match/other', 'match?other', 'match%2fother', 'match other', 'a'.repeat(151)]) {
      expect(() => parseMatchFeedbackCommand({ ...input, matchId })).toThrow();
      expect(() => assertMatchFeedbackView({ ...view, matches: [{ ...match, matchId }] }, binding)).toThrow('private match feedback');
    }
    for (const id of ['request.with.period', 'request:with:colon', 'short', 'a'.repeat(151)]) expect(() => parseMatchFeedbackCommand({ ...input, id })).toThrow();
  });
  it('rejects foreign bindings, teammate entries, extra private data and editable closed projections before UI rendering', () => {
    const binding = { accountId: 'own-account', teamId: 'roma', seasonId: '2026', role: 'player' as const, playerId: 'own-player' };
    const entry = { playerId: 'own-player', playerLabel: 'Own player', rating: 4, text: 'Own note', revision: 1, createdAtMs: 100, updatedAtMs: 100 };
    const match = { matchId: 'game', label: 'Roma v Milan', playedDate: '2026-10-24', completedAtMs: 10, closesAtMs: 1000, status: 'open', eligible: true, canEdit: true, own: entry };
    const view = { kind: 'match-feedback', accountId: binding.accountId, playerId: binding.playerId, teamId: binding.teamId, seasonId: binding.seasonId, audience: 'player', serverNowMs: 100, matches: [match] };
    expect(() => assertMatchFeedbackView(view, binding)).not.toThrow();
    for (const changed of [{ accountId: 'other' }, { teamId: 'other' }, { seasonId: 'other' }, { playerId: 'other' }, { audience: 'manager' }, { privateSource: 'raw document' }, { matches: [{ ...match, entries: [entry] }] }, { matches: [{ ...match, own: { ...entry, playerId: 'teammate' } }] }, { matches: [{ ...match, status: 'closed', closesAtMs: 50, canEdit: true }] }]) expect(() => assertMatchFeedbackView({ ...view, ...changed }, binding)).toThrow('private match feedback');
    const manager = { ...view, audience: 'manager', playerId: null, matches: [{ ...match, eligible: false, canEdit: false, own: null, entries: [entry] }] };
    expect(() => assertMatchFeedbackView(manager, { ...binding, role: 'manager', playerId: null })).not.toThrow();
  });
});
