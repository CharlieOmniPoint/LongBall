/** Read-only presentation derived from accepted match views in the current workspace. */
export function acceptedCompletedFixtureIds(
  matches: readonly { matchId: string; teamId?: string; seasonId?: string; status?: string; state?: { status?: string } }[] | null,
  scope: { teamId?: string; seasonId?: string },
): ReadonlySet<string> {
  if (!scope.teamId || !scope.seasonId) return new Set();
  return new Set((matches ?? [])
    .filter(match => match.teamId === scope.teamId && match.seasonId === scope.seasonId && (match.status === 'completed' || match.state?.status === 'completed'))
    .map(match => match.matchId));
}

/** A past date is not proof that a match was played. Lifecycle exceptions remain visible. */
export function fixtureScheduleStatus(
  fixture: { id: string; status: 'scheduled' | 'postponed' | 'cancelled'; playedDate: string },
  completedFixtureIds: ReadonlySet<string>,
  today: string,
): string {
  if (fixture.status === 'cancelled') return 'Cancelled';
  if (fixture.status === 'postponed') return 'Postponed';
  if (completedFixtureIds.has(fixture.id)) return 'Completed';
  return fixture.playedDate < today ? 'Past fixture' : 'Scheduled';
}
