# LongBall usability and match-day improvements — 24 October 2026

This work implements the owner's seventeen requested improvements on `dev/longball-m0-journey`. The native iPhone and Android targets, canonical match rules, full feature scope and approved visual direction remain applicable. Browser and native clients share application rules.

| Request | Implementation and acceptance check | Status |
| --- | --- | --- |
| 1 | Manager and Administrator can review and cancel or remove unplayed scheduled games; recording authority/history blocks destructive schedule changes. Audited reasons and revision checks are required. | In progress |
| 2 | Current Manager, Administrator, Player or Spectator role is visible in the signed-in header. | In progress |
| 3 | Compact squad replies and profile actions, paired Edit/Archive, progressive disclosure and usable touch targets at 320/390px. | In progress |
| 4 | Up to three saved lineup templates; configure, edit, archive, review and copy into a fixture without changing replies or starting a match. | In progress |
| 5 | Always available, labelled logout control for every role; private views close immediately and the service session is revoked. | In progress |
| 6 | Team catalogue of two-letter positions; core defaults retained, optional positions activate/deactivate, goalkeeper remains available, historical records remain interpretable. | In progress |
| 7 | Player My Stats shows only that player's known playing time, positions and scoring with coverage. | In progress |
| 8 | Select all manager-approved position eligibility. | In progress |
| 9 | Deterministic global auto-fill respects availability, actual attendance, eligibility, preferences and goalkeeper policy; produces a reviewable draft. | In progress |
| 10 | Team badge opens a high-level overview and the current/today's game, otherwise the next fixture. | In progress |
| 11 | Manager and Administrator can inspect per-player season statistics and formation position time/percentages. No unrelated private preparation or feedback is granted to Administrators. | In progress |
| 12 | Remove visible fictional/synthetic/sample data tags and implementation jargon while retaining useful data-quality and access information. | In progress |
| 13 | Mixed-child notices use the same application text styling; verify the reported score-publication notice. | In progress |
| 14 | UK display and calendar boundaries use `Europe/London`, including daylight-saving changes. | In progress |
| 15 | Display dates use two-digit years; canonical storage and machine inputs keep full ISO years. | In progress |
| 16 | Players with proved playing time can save 1–5 enjoyment stars and up to 256 Unicode characters after trusted full time until midnight London that day. Only the author and current team Managers can read it. | In progress |
| 17 | Player and Spectator journeys use clear primary actions, short navigation and optional details. Check all existing capabilities remain reachable. | In progress |

## Recorded decisions and outstanding gates

- The owner explicitly requested Administrator schedule management and aggregate player statistics. These are narrow new permissions, not permission to read private preparation, player comments or injuries.
- Removing a scheduled game means removing an unplayed schedule item with an audit record, not erasing match history or fulfilling a privacy deletion request.
- Saved templates and automatic placement create drafts. Attendance, replies, policy choices, accepted lineups and kickoff still require their existing explicit actions.
- Feedback closes at the next London midnight after the trusted actual completion time. A scheduled date alone cannot open feedback. Unproved finish or playing time remains unavailable pending review.
- Q05/Q09/Q10 privacy verification, retention and support authority remain pending at the owner's instruction. Physical iPhone/Android testing is deferred at the owner's instruction. No paid services are provisioned.
- Automated native builds cannot prove device background timing, encrypted storage or OS prompts. These remain device-test gates.

## Validation

Focused rule, route, database security and mobile checks are running during implementation. Final integrated results, publication source and browser evidence will be recorded here once checked; this document does not assert completion in advance.

## Review journey

- Sign in with an existing preauthorised account. The header identifies the current role and provides a labelled logout icon. Selecting the team badge opens Team Overview.
- Manager: open Team → Saved player setups to configure up to three setups. Open Schedule → a fixture to copy a setup, review availability and attendance, and prepare the match. Auto-fill available in the lineup editor creates a draft for review.
- Manager: open More → Team settings → Manage team positions to edit the active two-letter position catalogue. Player editing includes Positions → Select all for approved eligibility.
- Manager or Administrator: Schedule → an unplayed fixture → Cancel game or Delete item → review the reason and confirm. A game with recording authority or saved match history is protected.
- Player: Home offers My Stats and Match feedback; My Stats is also a primary navigation destination. More retains My profile, My game, reports and invitations. Players can change only their own replies and preferences.
- Manager or Administrator: Stats offers individual summaries and season position time/percentage in a formation. Manager-only player feedback is available under More → Player feedback.
- Spectator: Home shows the team and the current/next game. Scores, Results, Photos and Account remain direct navigation destinations.
- Player feedback opens only after trusted full time and recorded playing time, and closes at midnight in London on the actual completion day. Earlier feedback stays readable. Past sample-season games are intentionally closed; finishing today's game opens the eligible players' forms.

The shared demo uses generated accounts, teams and match records. No credentials are included in the app or this guide. Its bounded API runtime is separate from the lasting GitHub Pages link; deployment evidence records the current review window.
