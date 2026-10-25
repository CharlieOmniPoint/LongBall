import { describe, expect, it } from 'vitest';
import { RetainedAction } from '@longball/application/retained-action';
import { parseClubAdministrationReceipt } from './club-administration-receipt';
const valid = { kind: 'club-administration', administration: { level: 'super', clubIds: [] }, clubs: [{ id: 'club', name: 'Harbour Athletic' }], teams: [{ id: 'team', clubId: 'club', name: 'Falcons', ageGroup: 'U12', seasonId: 'season', seasonLabel: '2026/27', leagueName: '' }], administrators: [{ accountId: 'adult', level: 'super', clubId: null }], candidates: [{ accountId: 'adult', label: 'Priya Shah' }] };
describe('verified administration receipts', () => {
  it('adopts only bounded display and scope fields, removing unrelated data', () => {
    expect(parseClubAdministrationReceipt({ ...valid, ignored: 'private', candidates: [{ ...valid.candidates[0], password: 'must not be adopted' }] })).toEqual(valid);
    expect(parseClubAdministrationReceipt(valid).teams).not.toBe(valid.teams);
  });
  it('rejects corrupt, duplicate and cross-linked directory responses', () => {
    for (const value of [null, [], { ...valid, kind: 'other' }, { ...valid, teams: [{ ...valid.teams[0], clubId: 'foreign' }] }, { ...valid, clubs: [...valid.clubs, ...valid.clubs] }, { ...valid, teams: [...valid.teams, ...valid.teams] }, { ...valid, candidates: [{ ...valid.candidates[0], label: '' }] }, { ...valid, candidates: [...valid.candidates, ...valid.candidates] }, { ...valid, administrators: [{ ...valid.administrators[0], clubId: 'club' }] }]) expect(() => parseClubAdministrationReceipt(value)).toThrow(/could not be verified/);
    expect(parseClubAdministrationReceipt({ ...valid, teams: [...valid.teams, { ...valid.teams[0], seasonId: 'next-season' }] }).teams).toHaveLength(2);
  });
  it('does not let a Club Admin receipt expand into foreign club or system authority', () => {
    const club = { ...valid, administration: { level: 'club', clubIds: ['club'] }, administrators: [{ accountId: 'adult', level: 'club', clubId: 'club' }], candidates: [] };
    expect(parseClubAdministrationReceipt(club, { level: 'club', clubIds: ['club'] })).toEqual(club);
    expect(() => parseClubAdministrationReceipt(valid, { level: 'club', clubIds: ['club'] })).toThrow();
    expect(() => parseClubAdministrationReceipt({ ...club, administration: { level: 'club', clubIds: ['club', 'foreign'] } }, { level: 'club', clubIds: ['club'] })).toThrow();
    expect(() => parseClubAdministrationReceipt({ ...club, candidates: valid.candidates })).toThrow();
  });
  it('retains the original mutation key after a malformed success receipt', async () => {
    const action = new RetainedAction<{ type: string }, ReturnType<typeof parseClubAdministrationReceipt>>(), keys: string[] = [], writes = new Set<string>(); let attempt = 0;
    const send = async (_command: { type: string }, key: string) => { keys.push(key); writes.add(key); return parseClubAdministrationReceipt(attempt++ ? valid : { kind: 'club-administration', teams: [] }); };
    await expect(action.run({ type: 'club.create' }, () => 'key-one', send)).rejects.toThrow(/could not be verified/);
    await expect(action.run({ type: 'club.create' }, () => 'key-two', send)).resolves.toEqual(valid);
    expect(keys).toEqual(['key-one', 'key-one']); expect(writes.size).toBe(1);
  });
});
