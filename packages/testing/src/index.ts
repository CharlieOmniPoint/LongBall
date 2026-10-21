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
