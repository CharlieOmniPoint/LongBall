import { describe, expect, it } from 'vitest';
import { invitationTeamLabel, parseInvitationContext } from './invitation-context';
const context = { clubName: 'Richmond Rovers', teamName: 'Roma', ageGroup: 'U10', seasonLabel: '2026/27', inviterLabel: 'Team member' as const };
describe('readable invitation context boundary', () => {
  it('allows only bounded display fields and avoids repeating an existing age-group suffix', () => {
    expect(parseInvitationContext(context)).toEqual(context);
    expect(invitationTeamLabel(context)).toBe('Roma U10');
    expect(invitationTeamLabel({ ...context, teamName: 'Roma U10' })).toBe('Roma U10');
    expect(invitationTeamLabel({ ...context, ageGroup: null })).toBe('Roma');
  });
  it('rejects person labels, private fields and control characters without exposing them', () => {
    for (const value of [{ ...context, accountId: 'private' }, { ...context, inviterLabel: 'Named child' }, { ...context, teamName: 'Bad\nname' }, { ...context, clubName: 'x'.repeat(151) }]) expect(() => parseInvitationContext(value)).toThrow('Invitation context is unavailable.');
  });
});
