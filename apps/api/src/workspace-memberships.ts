import type { Membership } from '../../../packages/application/src/access';
import type { NamedWorkspaceMembership } from '../../../packages/application/src/workspace-context';

/** Public display metadata only. IDs, role and player binding remain unchanged authority. */
export interface WorkspaceMembershipNames {
  team_name?: unknown;
  season_label?: unknown;
  club_name?: unknown;
  age_group?: unknown;
}

function label(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim() || undefined;
}

export function namedWorkspaceMembership(membership: Membership, names?: WorkspaceMembershipNames): NamedWorkspaceMembership {
  const team = label(names?.team_name), ageGroup = label(names?.age_group);
  const teamName = team && ageGroup && !team.toLocaleLowerCase('en-GB').endsWith(` ${ageGroup.toLocaleLowerCase('en-GB')}`) ? label(`${team} ${ageGroup}`) ?? team : team;
  const seasonLabel = label(names?.season_label), clubName = label(names?.club_name);
  return {
    ...membership,
    ...(teamName ? { teamName } : {}),
    ...(seasonLabel ? { seasonLabel } : {}),
    ...(clubName ? { clubName } : {}),
  };
}
