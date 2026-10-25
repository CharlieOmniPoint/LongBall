import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGN_IN_RULES, parseSignInRules } from '@longball/application/identity-policy';
import { evaluateSignInRulesDraft } from './sign-in-rules-draft';

const source = parseSignInRules(DEFAULT_SIGN_IN_RULES);
const lengths = { usernameMin: '3', usernameMax: '40', passwordMin: '12' };
describe('application policy editing', () => {
  it('does not create a new update for unchanged rules or equivalent numeric formatting', () => {
    expect(evaluateSignInRulesDraft(source, source, lengths)).toMatchObject({ dirty: false, problem: null });
    expect(evaluateSignInRulesDraft(source, source, { ...lengths, usernameMin: '003' })).toMatchObject({ dirty: false, problem: null });
  });
  it('retains blank and unsupported numeric edits without accepting a policy', () => {
    for (const edit of [{ usernameMin: '' }, { usernameMin: '2' }, { usernameMax: '41' }, { passwordMin: '7' }, { passwordMin: '65' }]) {
      const value = evaluateSignInRulesDraft(source, source, { ...lengths, ...edit });
      expect(value.dirty).toBe(true);
      expect(value.rules).toBeNull();
      expect(value.problem).toMatch(/length must/);
    }
  });
  it('checks related username bounds before any mutation can be sent', () => {
    expect(evaluateSignInRulesDraft(source, source, { ...lengths, usernameMin: '24', usernameMax: '20' })).toMatchObject({ dirty: true, rules: null, problem: 'Maximum username length must be 8–40 characters and at least the minimum.' });
    const value = evaluateSignInRulesDraft(source, source, { ...lengths, passwordMin: '16' });
    expect(value).toMatchObject({ dirty: true, problem: null, rules: { password: { minLength: 16 } } });
    expect(source.password.minLength).toBe(12);
  });
  it('retains a changed switch and returns to clean when it is reversed', () => {
    const changed = { ...source, spectatorPin: { blockSimpleCodes: false } };
    expect(evaluateSignInRulesDraft(source, changed, lengths)).toMatchObject({ dirty: true, rules: { spectatorPin: { blockSimpleCodes: false } } });
    expect(evaluateSignInRulesDraft(source, { ...changed, spectatorPin: { blockSimpleCodes: true } }, lengths).dirty).toBe(false);
  });
});
