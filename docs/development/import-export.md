# Roster import and selected calendar export

These implement the two Should capabilities named in the canonical specification's delivery scope (line 202). They add no account service, external calendar integration, dependency or paid resource. The supplied canonical specification remains unchanged.

Managers open **Team → Import roster CSV**. Pasting and previewing are local, memory-only actions. The template requires display name, pitch initials, three distinct ranked preferences and explicit eligible positions; optional fields are shirt number, preferred foot and an opaque player ID. Blank foot means Not recorded. No goalkeeper eligibility is inferred. Unknown headers, including account, contact and date-of-birth fields, are rejected.

The parser supports UTF-8 BOM text, quoted commas, escaped quotes, quoted newlines and CRLF. Technical bounds are 65,536 characters and 200 rows. New opaque profile/player identities are allocated once per preview, rather than derived from names. Existing or repeated identities and active shirt-number conflicts are refused. Shared initials are allowed. Coincident display names produce a warning and still require the explicit distinct-new-player confirmation; names never trigger merging.

Confirmation sends one existing preparation mutation:

```json
{
  "command": {
    "id": "stable-command-id",
    "expectedRevision": 3,
    "type": "roster.imported",
    "profiles": [{
      "id": "opaque-new-profile",
      "playerId": "opaque-new-player",
      "seasonId": "selected-current-season",
      "displayName": "Fictional example",
      "initials": "FP",
      "shirtNumber": null,
      "foot": "not_recorded",
      "preferences": ["CM", "CB", "ST"],
      "eligiblePositions": ["CM", "CB", "ST"],
      "active": true
    }],
    "confirmNewPlayers": true
  }
}
```

The normal contract-version and idempotency headers apply. The shared reducer validates every profile before committing one revision and audit entry. Any invalid row rejects the entire batch. Exact retries return the saved result; reused keys with different content or stale revisions are refused. Both SQLite and PostgreSQL use current manager authority and the existing transactional roster-to-records bridge. Imports create no account, membership, activation or selection/attendance changes, and preserve saved match snapshots.

Managers and players open **Schedule → Export selected events**. Nothing is selected implicitly. Only upcoming scheduled entries visible in the current authorised schedule are offered; postponed/cancelled matches and held/cancelled training are excluded. Spectators gain no schedule right. Connected export reads fresh identity and fresh manager preparation or own-player preparation, then checks the account, API, team, season, role, player, generation, membership and unlocked session again before delivery. A known current-scope authority denial closes private views without deleting retained requests.

The ICS contains only stable opaque event references, generic match/training summaries, dates, recorded times and venue. It excludes roster names, attendance, responses, contacts, results and goals. Its constant filename is `longball-calendar.ics`. Recorded Europe/London times convert to UTC with DST checks; an ambiguous or nonexistent clock-change time is refused for review. An unknown kickoff remains `VALUE=DATE`. No end time, interval or duration is invented. Text is escaped and folded to at most 75 UTF-8 octets with CRLF line endings.

The browser explicitly downloads a file. Native uses the existing Expo share capability, rechecks access after writing, and deletes the app's temporary cache file even when sharing fails. The UI explains that a saved copy is outside LongBall and does not update automatically. LongBall performs no external calendar writes. The fictional local manager journey can export its local schedule and remains labelled as a rehearsal.

Validation for this isolated increment:

- 33 shared/platform tests, including existing preparation regressions, CSV boundaries, atomicity/idempotency, DST, escaped/folded ICS, delayed scope changes, revoked access and native temporary-file cleanup.
- Two actual SQLite HTTP tests and one actual PostgreSQL HTTP test in a disposable database. PostgreSQL used the explicit owner test fixture; this is not a new production RLS acceptance claim.
- Three actual phone-browser groups: manager import and calendar at 320 px, own-player calendar at 390 px. The exact asset and safe screenshots are in [the evidence folder](evidence/2026-10-21/import-export/README.md).
- Root and mobile TypeScript, changed-file ESLint and whitespace checks passed.

Physical iPhone/Android sharing destinations, keyboard behavior and accessibility remain device checks. Public fictional identities in browser evidence do not prove production authentication. Existing owner-gated policies are unchanged.
