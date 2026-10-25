import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGN_IN_RULES } from '@longball/application/identity-policy';
import { parseSignInRulesDto } from './sign-in-rules';
const valid = { kind: 'sign-in-rules', revision: 1, rules: DEFAULT_SIGN_IN_RULES, provider: { status: 'not_configured', detail: 'Password provider is not connected.' } };
describe('application policy receipts', () => {
  it('keeps only a validated revision, rules and provider status', () => {
    expect(parseSignInRulesDto({ ...valid, ignored: 'not adopted' })).toEqual(valid);
    expect(parseSignInRulesDto(valid).rules).not.toBe(DEFAULT_SIGN_IN_RULES);
  });
  it('refuses invalid revisions and provider metadata before a view can adopt a receipt', () => {
    for (const value of [null, [], { ...valid, kind: 'other' }, { ...valid, revision: -1 }, { ...valid, revision: 1.2 }, { ...valid, provider: null }, { ...valid, provider: { status: 'unknown', detail: '' } }, { ...valid, provider: { status: 'applied' } }, { ...valid, provider: { status: 'pending', detail: 'x'.repeat(501) } }, { ...valid, rules: { ...valid.rules, password: { ...valid.rules.password, minLength: 1 } } }]) expect(() => parseSignInRulesDto(value)).toThrow();
  });
});
