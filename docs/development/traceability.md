# Capability traceability

> Current recheck: [original specification comparison](specification-recheck.md) records newly found UI, viewer-refresh, report and clock-integrity gaps and their candidate fixes. The earlier blanket completeness assessment is superseded. New source verification/publication is in progress; privacy fulfilment and operator support remain explicitly incomplete behind owner decisions.

> Historical 20 October M0 baseline. Its table records the original slice and the work outstanding then. The 21 October capability checkpoints, published full implementation are tracked in [full-build-plan.md](full-build-plan.md), [review.md](review.md) and the [entry audit](entry-completion-audit.md). Physical-device acceptance remains open and is currently deferred.

20 October 2026. All F01–F28 remain the integrated pilot target. `Initial` means an intermediate synthetic/local implementation target, not end-to-end product acceptance. At this original baseline, API, identity and shared server authority were later work; their subsequent actual evidence is recorded in the linked registers. Real-data release remains unaccepted. The canonical acceptance criteria remain [the source of truth](../longball/LongBall_Mobile_Build_Pack_v0_1.md#capability-backlog-and-end-to-end-acceptance).

| Capability | UI / rule trace | Original initial increment boundary | Outstanding at the original M0 baseline |
| --- | --- | --- | --- |
| F01 Club/team configuration and logos | UI09/UI32, D20 | Fictional team context/original neutral badge. | Authorised writes, inheritance/override and asset rights. |
| F02 Seasons/rollover | UI03/UI25/UI32, D16 | Fixed fictional 2026/27 context. | Immutable prior season, explicit access renewal and chronology. |
| F03 Player profiles/snapshots | UI09/UI10, D13/D21 | 13 fictional records only. | Secure editing, immutable match snapshots, identity uniqueness. |
| F04 Position preferences/eligibility | UI10/UI11/UI13, ME04/ME32 | Explicit fictional goalkeeper eligibility. | Three ranked preferences, snapshot semantics and all position constraints. |
| F05 Accounts/activation/security | UI01–UI03/UI31–UI35, SEC01–SEC09 | No real accounts; synthetic manager context. | Adult verification/MFA, recovery, four-manager rule and denial tests. |
| F06 Fixtures | UI06/UI07/UI13, REP07 | One fictional Roma v Maple FC review fixture. | Create/reschedule/postpone/cancel/override and idempotent service writes. |
| F07 Availability responses | UI05–UI08, REP02 | Synthetic responses shown separately from check-in. | Authenticated own response, no-response semantics and history. |
| F08 Training/attendance | UI06/UI08/UI26, REP02 | Match attendance check-in foundations only. | Training dates/occurrences, manager marking, excused policy and own view. |
| F09 Formations | UI11/UI13, D03/ME13 | Seven distinct fixture slots with tap/list route. | Reusable 5–11 templates, stable role mapping and authorised persistence. |
| F10 Match setup | UI12/UI13, ME10/MT01 | Validated staged fictional lineup and atomic local start. | Download authority, full settings/policy validation and accepted server start. |
| F11 Match clock | UI14/UI18–UI20, ME10–ME12/MT03–MT05 | Manual halves, pause/resume, independent second countdown and overtime. | Native continuity/recovery proofs, full-time UTC quality and corrections. |
| F12 Participation/positions | UI14/UI16/UI24/UI26, ME13/MT16 | Pure reducer tracks playing/available-bench/unavailable intervals and position totals; boundary tests exercise conservation and vacancy. | Complete UI, audited history corrections, role-filtered reports and server replay. |
| F13 Fairness planner | UI12–UI14/UI16/UI26, ME20–ME44 | Exact rational targets/projections and individual-band comparisons; narrow FV06 fixed-grid capacity certificate. No complete solver claimed. | Deterministic validated schedules, equal keeper duties, constraints, budget and proof statuses. |
| F14 Substitutions | UI13/UI16/UI18, D14/MT02/MT14 | Staged pre-match/half-time changes and explicit local live-lineup review/commit; reducer rejects stale source revisions. | Full live slot-selection usability, audited corrections, fair-time suggestions, replanning and accepted server events. |
| F15 Alerts | UI12/UI14/UI16/UI33, ME60/MT21–MT22 | M0 adapter experiment. | Current-plan foreground behaviour, cancellation and physical fallback limits. |
| F16 Goals/own goals | UI14/UI15/UI21/UI24, EV04 | No complete goal workflow implied by clock slice. | Effective-time capture, both own-goal classifications, correction and once-only replay. |
| F17 Injury/unavailability | UI13/UI17/UI24, ME23/MT11 | Availability validation only. | Effective-time departure/return/vacancy handling and restricted details. |
| F18 Match report | UI19/UI24, REP01 | Local manager rehearsal record shows active duration, actual playing time and position totals. | Complete audience-filtered report, goal/score provenance, completeness and correction projections. |
| F19 Attendance/season reports | UI25/UI26, REP02–REP04 | No season aggregation acceptance. | Explicit denominators, own-only named records, historical unknowns and preference snapshot rules. |
| F20 Offline/control/recovery | UI13/UI14/UI20/UI33, ME50–ME54/MT17–MT20/MT31 | Local event/journal M0 experiment and uncertainty detection. | Server grants/epoch fencing, offline bundle, retry, handover, quarantine and reconciliation. |
| F21 Score-aware positions | UI12/UI14/UI16, D10/ME32 | Retained backlog. | Explicit threshold/return choice; decision-point recommendation only, never automatic moves. |
| F22 Spectators | UI01–UI03/UI21/UI31/UI35, REP05/CP-01–CP-04 | Retained backlog; no real score sharing. | Invite acceptance/revocation/season expiry, role denial, truthful recorder freshness and Q21 policy. |
| F23 Private award ballot | UI05/UI19/UI21/UI22/UI24, REP06/ME61 | Retained backlog. | One changeable private ballot, candidate/voter validation, joint winners and original +60 deadline; +59 cutoff remains Q15 proposal. |
| F24 Practical sub timing | UI12–UI14/UI16/UI18, D22/ME31 | Rules retained in documentation; operational scheduling is not implemented. | Solver/window trade-offs, five-minute/03:45–21:15 preferences, manager exceptions and actual-time replanning. |
| F25 Global identity/team separation | UI02/UI03/UI10/UI31–UI35, SEC07/SEC10 | Single fictional team; no identity implementation. | Global account with isolated team-season records, role and cross-team negative tests. |
| F26 Photos/moderation/library | UI27–UI30, SEC13–SEC17 | Retained backlog; no real photos or uploads. | Safe processing, exact-revision approval, deliberate manager publish, gateway, concern/block/removal. |
| F27 Results/points/form | UI21/UI24/UI25, REP07/RT07 | Retained backlog. | 3/1/0 all ordinary completed games incl friendlies; corrections and Q21 aggregate restrictions. |
| F28 Historical results | UI23–UI26, REP01/MT25 | Retained backlog. | Summary provenance, unknown attendance/minutes/half score, unassigned scorers and no fresh voting/alerts. |

## Current source and release coverage

The historical table above is not the current gap list. Pages now serves source `c53841966c822f7a5172584370b6a557833398b4`, containing accepted product `e899e29` and its discovery-cache correction. Actual [external 390px entry](evidence/2026-10-21/full-publication/final-entry.json) passed at 20:21:22 UTC; [all four loaded connected roles](evidence/2026-10-21/full-publication/final-connected-roles.json) passed at 20:28:27 UTC on 21 October, with fresh API/source/CORS checks, no failed API responses, runtime errors or horizontal overflow. The role check made no service writes and left the default fixture unclaimed.
[Current functional acceptance](evidence/2026-10-21/review-discovery-followup.json) passed 686 shared/platform tests, complete static/boundary checks, 18 browser groups, six anonymous-entry checks, six native-configuration groups and both fresh Hermes exports. All five backend MJS artifacts remain identical to the quiet 284/45 API pass; schema15 operational proof inputs are unchanged. The browser evidence discloses an earlier unreproduced reset and diagnostic separately; no first-run/no-retry claim or count inflation is made.

The latest [native CI proof](evidence/2026-10-21/full-publication/native-final.json) passed Android arm64 Debug and unsigned x86_64 iOS Simulator Debug for exact published source `c538419`. The earlier [source-bound native run](evidence/2026-10-21/full-publication/native-initial.json) passed both Android debug and unsigned iOS Simulator Debug for `d08666f`. No installation or physical execution is proved. Native signing/physical M0, operating providers/storage/recovery, new production-image validation and unresolved privacy/audience policy remain separate. Hardware testing is deferred. Other-club creation remains future scope. Earlier `f4fbffe` entry/matchday/native records are historical; no policy or paid-service approval is inferred.

## Evidence interpretation

Existing artifact/schema validation establishes specification integrity and contract structure. Unit checks establish only exercised deterministic behaviour. Browser journey checks establish only the observed review interactions. Native bundle export establishes JavaScript packaging. Native compilation establishes a binary can be built. M0 requires the physical device evidence in [the proof register](implementation-scope.md#native-m0-proof-register); no lower-level check substitutes for it. Access, migration, API integration, end-to-end native, restore and operational suites are not passing merely because their future command names are specified.
