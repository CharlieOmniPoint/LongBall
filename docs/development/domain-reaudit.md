# Domain, attendance and shared-view re-audit

21 October 2026. This review compares the canonical build pack's D03–D05, D14, D23–D26, ME10–ME61, REP01–REP07 and applicable F07/F11–F28 boundaries with the current reducer, planner, service and repository source. It supplements the full build-plan audit; it is not physical-device or production release evidence.

## Concrete gaps closed

| Requirement | Before this review | Final implementation |
| --- | --- | --- |
| REP02/F07/F19 game responses remain distinct from check-in | Every game attendance report emitted `availabilityResponse: null`, even when preparation held a response. | Scoped preparation evidence maps profile IDs to team-season player IDs. Manager changes project transactionally; report reads use the current durable preparation evidence. Received response, explicit no reply and unknown historical evidence remain distinct. Attendance, active availability and minutes are never inferred from RSVP. |
| REP02 event identity and source provenance | Game records lacked event type, excused status and source references. | Game/training records identify event type and excused status, with preparation revision/command provenance where recorded. Game rows also retain record/match revision and update time. Earlier missing source evidence remains null. |
| SEC10 own-player updates under restricted PostgreSQL | Own preference/training updates could attempt to write the manager records document; the first actual PostgreSQL run exposed a 422 refusal. Adding fixture projection exposed the same flaw for own RSVP. | Own mutations persist only their authorised preparation document. Reports derive its current scoped evidence at read time. No player records-write grant, privileged bypass or migration was introduced. |
| F02/D13 team-season separation | A newly introduced RSVP projection could otherwise be copied by records rollover. | Both local and service rollover explicitly clear game preparation evidence; old-season documents remain intact. |
| ME11/ME13 integer-millisecond integrity | Any finite monotonic number was accepted. `1e308` could accrue unsafe duration during a retrospective correction whose effective goal boundary was still safe; adding two safe clock values could also overflow. Both regression tests first failed because no error was thrown. | Monotonic samples must retain safe integer precision after flooring. Active half/match sums validate before a projection is returned. Fractional native/browser samples remain supported. API envelope validation enforces the same sample boundary. |
| API06 accepted shared viewing | The first new polling implementation retained completed cached matches indefinitely. | Independent follow-up identified the missing late-correction/policy-withdrawal path. The foreground implementation now sweeps loaded history in bounded pages on the slower cadence while active games refresh separately. Scope/session checks, aborts and the user's history cursor remain separate. |

## Meaningful checks run

- 83 tests passed across game-evidence, records, records-service, preparation, planner and season-service files. These overlap the normal unit suite and are not added to its total.
- Eight HTTP tests passed with both SQLite and actual PostgreSQL using separate non-owner API roles. They include immediate own RSVP/report output, manager changes, exact duplicate-key replies, own-only records, spectator denial, JSON export, forged evidence denial, own training/preferences and zero ambient PostgreSQL document reads. The final run took 39.14 seconds with no skips.
- Two API clock-precision tests passed, retaining valid fractional readings while rejecting unsafe/nonfinite/negative evidence.
- The post-guard domain run passed all 38 tests across match, live-event and accepted replay-compatibility files with one worker in 2.32 seconds. Its preceding concurrent run passed 36 tests but timed out two existing synchronous tests at the unchanged five-second limit; the same source and assertions passed the bounded-worker rerun. No timeout or assertion was relaxed.
- Scoped ESLint and diff whitespace checks passed. Aggregate root/mobile TypeScript, complete suites and browser/publication checks belong to the final checkpoint and must be read with that source's evidence.

## Rechecked boundaries and remaining gates

Manual halves, independent second-half countdown, exact availability-weighted targets, position/participation conservation, confirmed batches, late corrections, keeper sharing, deterministic budget results, per-device sequence continuation and epoch fencing remain implemented. Private ballots, original finish-relative deadlines, historical unknowns and permission-filtered report/exports retain their existing boundaries. The supplied competition/keeper/controller/cutoff exceptions remain explicit proposals; this review does not approve them.

The shared-view follow-up was reviewed after the historical-cache fix. Active-filter cursors bind account, issuer, subject, team, season, role, player and filter; unfiltered cursor compatibility is preserved. Scoped replies are rechecked after asynchronous reads. Authority failures close private cached views. A history refresh replaces only already-known IDs and does not advance the user's keyset page. Large loaded history is revalidated in batches rather than claimed to be instantaneously current.

Native encryption/key-loss/backup behaviour, sleep/reboot continuity, permissions, notifications, signed installation and actual touchline performance still require the deferred phone tests. Real identity/push/durable hosting, current production-image acceptance, privacy lifecycle and operating decisions remain separate release gates.
