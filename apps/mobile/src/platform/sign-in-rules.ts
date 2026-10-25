import { parseSignInRules, type SignInRulesDto } from '@longball/application/identity-policy';

export function parseSignInRulesDto(value: unknown): SignInRulesDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The application sign-in rules could not be verified.');
  const dto = value as Record<string, unknown>;
  const provider = dto.provider as Record<string, unknown> | undefined;
  if (dto.kind !== 'sign-in-rules' || !Number.isSafeInteger(dto.revision) || Number(dto.revision) < 0 || !provider || typeof provider !== 'object' || !['applied', 'not_configured', 'pending'].includes(String(provider.status)) || typeof provider.detail !== 'string' || provider.detail.length > 500) throw new Error('The application sign-in rules could not be verified.');
  return { kind: 'sign-in-rules', revision: Number(dto.revision), rules: parseSignInRules(dto.rules), provider: { status: provider.status as SignInRulesDto['provider']['status'], detail: provider.detail } };
}
