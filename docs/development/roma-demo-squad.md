# Roma U10 demo squad

The owner replaced the earlier 13-player sample squad with these eight players on 25 October 2026. This changes the demo seed; team-size limits and match rules are unchanged.

| Primary position | Player | Initials | Preferred foot |
| --- | --- | --- | --- |
| GK | Thomas Arnold | TA | Right |
| CB | Ralph Barrett | RB | Right |
| CB | Conor Kyne | CK | Right |
| CM | Max Holland | MH | Right |
| CM | Aryan Applegard | AA | Right |
| LW | Seb Lawler | SL | Left |
| RW | Ezra Philips | EP | Right |
| ST | Archie Muir | AM | Right |

Stable player identities 01–08 are retained. The existing Player demo account now belongs to Thomas Arnold; login credentials are unchanged and remain outside the application and documentation. Removed seed players have no new accounts, memberships, training records or fixture selections.

The supplied positions are primary preferences. Existing position templates supply editable secondary/third preferences and eligibility; those defaults are not additional preferences supplied by the owner. The suggested seven-a-side starting lineup uses the listed primary positions, with one of the two central midfielders on the bench.

All four fixtures select this eight-player squad. The two completed games retain their 2–2 and 3–1 results and two 25-minute halves. Recorded historical lineups rotate one outfield bench place every 6m15: Thomas plays 50 minutes in goal, outfield totals range from 37m30 to 43m45, and each game conserves 350 player-minutes. Goal scorers are on the pitch when their goals occur. Future availability responses remain separate from actual attendance.

The original supplied specification and older source-qualified evidence remain unchanged. This owner-requested demo update supersedes only the earlier D16 sample roster, not its general supported squad capability.

## Published review

Product `6044534f2962fd1a4d58e70c612ee859f0c36f79` is published at [the browser demo](https://charlieomnipoint.github.io/LongBall/?review=6044534). The live API returned exactly these eight names, initials, primary positions and feet, and eight selected profiles in all four fixtures. The bounded connected session expires at 14:04 UK time on 25 October 2026. [Verification and its limits](evidence/2026-10-25/roma-squad/verification.json) distinguish the successful live API check, local compiled-interface journeys and the inconclusive initial remote Team-text attempt.

The full shared suite passed 914 cases and the actual SQLite/PostgreSQL API suite passed 459, with three explicit host HEIC-helper skips. The local M0 browser journey passed ten groups, the expansion journey six groups, and the account journey eight role/width journeys with 27 groups. A test-only setup correction starts the new squad in its actual primary positions; deployed product behaviour is unchanged by that correction.
