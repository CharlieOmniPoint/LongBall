import { parseSignInRules, type SignInRules } from '@longball/application/identity-policy';

export interface SignInRulesLengths {
  usernameMin: string;
  usernameMax: string;
  passwordMin: string;
}

/** Raw form edits are retained even when they cannot yet become a valid policy. */
export function evaluateSignInRulesDraft(source: SignInRules, draft: SignInRules, lengths: SignInRulesLengths): {
  dirty: boolean;
  problem: string | null;
  rules: SignInRules | null;
} {
  const minimum = Number(lengths.usernameMin), maximum = Number(lengths.usernameMax), password = Number(lengths.passwordMin);
  let problem: string | null = null;
  if (!/^\d+$/.test(lengths.usernameMin) || minimum < 3 || minimum > 32) problem = 'Minimum username length must be 3–32 characters.';
  else if (!/^\d+$/.test(lengths.usernameMax) || maximum < 8 || maximum > 40 || maximum < minimum) problem = 'Maximum username length must be 8–40 characters and at least the minimum.';
  else if (!/^\d+$/.test(lengths.passwordMin) || password < 8 || password > 64) problem = 'Minimum password length must be 8–64 characters.';
  const rawChanged = JSON.stringify(source) !== JSON.stringify(draft)
    || lengths.usernameMin !== String(source.username.minLength)
    || lengths.usernameMax !== String(source.username.maxLength)
    || lengths.passwordMin !== String(source.password.minLength);
  if (problem) return { dirty: rawChanged, problem, rules: null };
  try {
    const rules = parseSignInRules({ ...draft, username: { ...draft.username, minLength: minimum, maxLength: maximum }, password: { ...draft.password, minLength: password } });
    return { dirty: JSON.stringify(source) !== JSON.stringify(rules), problem: null, rules };
  } catch {
    return { dirty: rawChanged, problem: 'Check the supported sign-in rules before saving.', rules: null };
  }
}
