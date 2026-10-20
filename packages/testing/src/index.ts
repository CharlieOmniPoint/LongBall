import fixture from '../../../fixtures/roma.synthetic.json';

export const romaFixture = fixture;

/** Guard the deliberately fictional M0 seed before writing it into local tooling. */
export function assertSyntheticFixture(value: typeof fixture): void {
  if (value.synthetic !== true || value.teamId !== 'synthetic-roma-u10') {
    throw new Error('Only the synthetic Roma fixture is supported.');
  }
  const ids = new Set(value.players.map((player) => player.id));
  if (value.players.length !== 13 || ids.size !== 13) {
    throw new Error('Roma requires 13 distinct synthetic players (D16).');
  }
  if (value.players.some((player) => !/^synthetic-player-\d{2}$/.test(player.id) || !/^Player \d{2}$/.test(player.displayName))) {
    throw new Error('Use fictional fixture identifiers and display names only.');
  }
  const available = value.players.filter((player) => player.available);
  if (available.length !== 9 || !available.some((player) => player.goalkeeperChoice === 1)) {
    throw new Error('The initial M0 scenario needs nine selected players including a goalkeeper.');
  }
  if (value.pitchPlaces !== 7 || value.plannedHalfDurationMs !== 1_500_000) {
    throw new Error('Roma uses seven pitch places and two planned 25-minute halves (D11).');
  }
}
