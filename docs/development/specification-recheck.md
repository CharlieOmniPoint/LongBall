# Original-specification recheck — 21 October 2026

This recheck compares the preserved original canonical mobile build pack, BUILD_START, D01–D28, F01–F28, UI01–UI35, match/report/data/security/quality requirements, contracts, approved three visual boards and work plan with current source and actual checks. It supersedes the earlier blanket functional-completeness assessment. The original archive and historical evidence remain unchanged.

## Findings and implementation

| Original requirement | Finding in the previously published review | Candidate correction / verification |
| --- | --- | --- |
| UX information architecture / UI04–UI06 / approved boards | Connected role navigation appeared above scrolling content. | Native layout owns scrolling content separately from fixed, safe-area bottom navigation for all four roles. Check320/390px positioning and retained navigation while scrolling. |
| UI13/UI14/UI18 / WF02–WF03 | Elapsed time dominated the countdown; recording prose pushed the console down; primary actions scrolled away. | Fixed score/half countdown and explicit Start/manual clock/Goal/Substitute/Unavailable rail, independently scrolling pitch/forms/planner/details. Zero still never ends a half; every actual change retains its confirmation. |
| UI05 / UI22 | Closed ballots disappeared from Player Home instead of showing final/pending recognition. | Role-filtered home award card for awaiting result, review, final/joint/no-valid-votes and missed deadline. Private tallies remain absent. |
| UI06 | Player Schedule lacked match/training filters. | All/Matches/Training filters alongside Upcoming/Past, with truthful filtered empty states. |
| API06 / QL05 / UI21 | Connected spectators needed manual refresh. | Foreground active-game polling, separate slower related/history reads, bounded backoff, abort on background/scope/session change, fresh authorisation and exact terminal refresh. Recorder freshness never becomes viewer fetch time. |
| Q21 / ME54 / correction propagation | A retired completed-game refresh cache could retain an old score/policy after full time. | Second-pass finding: refresh loaded history without replacing pagination or letting retired cache override newer authorisation/corrections. Verify denied policy and same-revision projection changes. |
| REP02 / F07 / F19 | Match RSVP was discarded in participation reports; own training/preferences could attempt a forbidden records write under restricted PostgreSQL. | Preserve preparation-response evidence, display RSVP separately from actual attendance, derive current own responses at read boundaries and retain manager-only records writes. Test own-only filtering, exports, exact retries and both database backends. |
| ME11/ME13/ME50 | Extreme finite monotonic values could exceed safe integer durations through retrospective correction. | Validate safe integer-millisecond ranges and accumulation while preserving ordinary fractional platform samples. Add malformed retrospective regression. |
| Reproducible build / SEC22 | Missing `db:migrate:check`, PR/development quality CI and retained scan/inventory procedures. | Real PostgreSQL migration command, source-secret scan with exact reviewed false-positive digests, dependency/licence inventory, registry audits, source/native/browser checks and independent clean-runner production-image exercise. |
| Demo review quality / user direction | Numbered player labels, sparse schedule and repeated “fictional” copy made functional review less representative. | Generated named Roma squad and adult personas, eight fixtures and seven training dates; clean Demo/sample language. Explicit non-production demo option supplies sharing/voting examples and original people-free artwork through normal scanning/moderation. Stable IDs and existing journals are preserved. |

The 45-minute example ballot cutoff and demo-only sharing are test configuration, not approval of Q15/Q21. No real child data, photographs, new roles, paid service or permission widening is introduced.

## Scope reconciliation

All F01–F28 remain in the integrated target. Source includes club/team/logo inheritance, seasons/rollover, profiles/snapshots/preferences, activation/identity/roles, fixtures/availability/training, formations/setup, clock/participation/fairness/substitutions/alerts/goals/availability changes, filtered reports, offline recording/controller/history, score-aware planning, spectator access, private awards, global identity, moderated media, results and historical entry. Recurring training, roster CSV import, selected calendar export and reusable match plans remain implemented Should features. The [traceability register](traceability.md), [screen audit](entry-completion-audit.md) and [full build plan](full-build-plan.md) retain per-ID source paths and evidence; this recheck adds the above missing integrations rather than redefining scope.

This is not proof that every UI error permutation, performance target or physical behavior has passed. Actual source-bound results belong in the evidence record after the candidate is frozen and tested.

## Work requiring a decision or external acceptance

- **SEC20/SEC21 privacy fulfilment remains incomplete:** request capture/status is implemented; a verified account export, retention-aware deletion/anonymisation, processor/session/device/media revocation and restore-time deletion ledger still need an approved workflow and implementation. Q05/Q09/Q10 must establish verification, data categories/retention, authority, operator and fulfilment responsibility. A request receipt must never say data was erased.
- **M0/M5/M6 physical and distribution gates:** both native targets remain; signing/install, encrypted process restart/key loss/backup behavior, real clock sleep/reboot, alerts, OS authentication/prompts, picker/share/system browser, large text/screen readers/outdoor use and battery require actual devices. Physical testing remains deferred at the user's direction.
- **Operating configuration:** real identity/email/push, permanent service/storage, monitoring/support/moderation/recovery ownership and account/store arrangements are not configured. The bounded demo is not persistent production hosting.
- **Unresolved policies:** Q05/Q06/Q07/Q08/Q09/Q10/Q14/Q15/Q18/Q20/Q21 retain their recorded status. No demographic naming, exceptional keeper/match, vote timing, recovery, retention or competition-sharing proposal is silently approved.
- **Security advisories:** the current registry scan reports two high build-tool-chain advisories without published patched versions and a moderate build-tool UUID advisory. Record exact versions, paths and upstream references in quality evidence. API/runtime lock scans are separate. Do not invent a passing dependency scan or apply untested major overrides.
- **Quality/operating targets:** physical local performance/accessibility/battery, live-network p95, monitored offsite15-minute recovery point/four-hour recovery, monthly availability and actual delivery/provider behavior need their specified conditions. Local benchmark or restore evidence does not establish all of them.

## Verification and publication

Candidate verification, second-pass fixes, public deployment and remaining CI outcomes will be recorded here and in the source-bound evidence before the review is reported ready. Historical source `c538419` and its two native compile successes remain historical until the new candidate is built and checked.
