import fixture from '../../../fixtures/roma.synthetic.json';

export const romaFixture = fixture;

/** Display labels for the generated demo accounts. Stable IDs keep review work attached to its original identity. */
export const demoAccountLabels: Readonly<Record<string, string>> = {
  'synthetic-account-manager': 'Alex Morgan',
  'synthetic-account-manager-2': 'Priya Shah',
  'synthetic-account-manager-3': 'Dan Foster',
  'synthetic-account-manager-4': 'Chris Lewis',
  'synthetic-account-manager-5': 'Nicky Hughes',
  'synthetic-account-admin': 'Sam Taylor',
  'synthetic-account-spectator': 'Jamie Bennett',
  'synthetic-account-invitee': 'Casey Bennett',
  'synthetic-account-other-manager': 'Robin Ellis',
  ...Object.fromEntries(fixture.players.map((player) => [`synthetic-account-player-${player.id.slice(-2)}`, player.displayName])),
};

/** Validate the supplied generated seed before local tooling writes it. This is not an anonymisation service. */
export function assertSyntheticFixture(value: typeof fixture): void {
  if (value.synthetic !== true || value.demo?.generated !== true || value.teamId !== 'synthetic-roma-u10') {
    throw new Error('Only the generated synthetic Roma demo fixture is supported.');
  }
  const ids = new Set(value.players.map((player) => player.id));
  if (value.players.length !== 13 || ids.size !== 13) {
    throw new Error('Roma requires 13 distinct sample players (D16).');
  }
  if (value.players.some((player, index) => !/^synthetic-player-\d{2}$/.test(player.id) || player.displayName !== fixture.players[index]?.displayName)) {
    throw new Error('Use the supplied generated sample identities only.');
  }
  if (value.profiles.length !== 13 || new Set(value.profiles.map(profile => profile.playerId)).size !== 13 || value.profiles.some(profile => !ids.has(profile.playerId) || !/^[A-Z]{2,3}$/.test(profile.initials) || !Number.isSafeInteger(profile.shirtNumber) || profile.shirtNumber < 1 || !['left', 'right', 'both', 'not_recorded'].includes(profile.foot))) {
    throw new Error('Sample profiles need an exact unique player join and valid shirt/initial/foot details.');
  }
  const positions = ['GK', 'CB', 'LB', 'RB', 'CM', 'LW', 'RW', 'ST'];
  if (value.profiles.some(profile => profile.preferences.length !== 3 || new Set(profile.preferences).size !== 3 || profile.preferences.some(position => !positions.includes(position)) || profile.eligiblePositions.length === 0 || profile.eligiblePositions.some(position => !positions.includes(position)))) {
    throw new Error('Sample profiles need three distinct ranked positions and valid eligible positions.');
  }
  const played = value.fixtures.filter(fixture => fixture.demoPhase === 'completed'), upcoming = value.fixtures.filter(fixture => fixture.demoPhase === 'scheduled');
  if (value.fixtures.length !== 4 || played.length !== 2 || upcoming.length !== 2 || played.some(fixture => fixture.playedDate >= value.demo.referenceDate) || upcoming.some(fixture => fixture.playedDate <= value.demo.referenceDate)) {
    throw new Error('The Roma demo needs exactly four matches: two played and two upcoming.');
  }
  if (value.fixtures.some(fixture => fixture.selectedPlayerIds.length !== fixture.selectedCount || new Set(fixture.selectedPlayerIds).size !== fixture.selectedCount || fixture.selectedPlayerIds.some(playerId => !ids.has(playerId)))) {
    throw new Error('Each sample match needs a distinct selected squad from the Roma roster.');
  }
  const available = value.players.filter((player) => player.available);
  if (available.length !== 9 || !available.some((player) => player.goalkeeperChoice === 1)) {
    throw new Error('The initial M0 scenario needs nine selected players including a goalkeeper.');
  }
  if (value.pitchPlaces !== 7 || value.plannedHalfDurationMs !== 1_500_000) {
    throw new Error('Roma uses seven pitch places and two planned 25-minute halves (D11).');
  }
  const events = [...value.fixtures.map((item) => ({ id: item.id, date: item.playedDate })), ...value.training];
  if (new Set(events.map((event) => event.id)).size !== events.length || events.some((event) => !/^202[67]-\d{2}-\d{2}$/.test(event.date) || !Number.isFinite(Date.parse(event.date)) || new Date(event.date).toISOString().slice(0, 10) !== event.date || event.date < '2026-09-01' || event.date > '2027-08-31')) {
    throw new Error('Sample events need distinct identities and valid dates in the 2026/27 season.');
  }
  if (value.fixtures.some((item) => !value.opponents.some((opponent) => opponent.name === item.opponent) || !Number.isSafeInteger(item.selectedCount) || item.selectedCount < 0 || item.selectedCount > value.players.length)) {
    throw new Error('Sample fixtures need a known opponent and an achievable squad.');
  }
}
