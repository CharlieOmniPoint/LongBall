/** Human-readable metadata from the exact server-validated invitation scope. */
export interface InvitationContext {
  clubName: string;
  teamName: string;
  ageGroup: string | null;
  seasonLabel: string | null;
  inviterLabel: 'Team manager' | 'Team member';
}
const label = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 150 && !/[\u0000-\u001f\u007f]/.test(value);
export function parseInvitationContext(value: unknown): InvitationContext {
  const fields = ['clubName', 'teamName', 'ageGroup', 'seasonLabel', 'inviterLabel'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invitation context is unavailable.');
  const context = value as Record<string, unknown>;
  if (Object.keys(context).length !== fields.length || fields.some(field => !Object.hasOwn(context, field)) || !label(context.clubName) || !label(context.teamName) || !(context.ageGroup === null || label(context.ageGroup)) || !(context.seasonLabel === null || label(context.seasonLabel)) || !['Team manager', 'Team member'].includes(context.inviterLabel as string)) throw new Error('Invitation context is unavailable.');
  return { clubName: context.clubName, teamName: context.teamName, ageGroup: context.ageGroup, seasonLabel: context.seasonLabel, inviterLabel: context.inviterLabel } as InvitationContext;
}
export function invitationTeamLabel(context: InvitationContext): string {
  return context.ageGroup && !context.teamName.toLocaleLowerCase().endsWith(` ${context.ageGroup.toLocaleLowerCase()}`)
    ? `${context.teamName} ${context.ageGroup}` : context.teamName;
}
