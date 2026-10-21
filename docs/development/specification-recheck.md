# Original-specification recheck — 21 October 2026

Development checkpoint `bb509f7` contains the latest readable-report and database fixes; a revised PostgreSQL-locking candidate awaits target measurement. The public Pages build remains older `c538419`, and new publication is pending. This recheck compares the preserved canonical pack, README/BUILD_START, D01–D28, F01–F28, UI01–UI35, match/report/security/quality contracts, three approved visual boards and work plan. It supersedes the earlier blanket completion assessment. Original files, checksums and historical evidence remain unchanged.

## Findings and implementation

| Original requirement | Finding in the previously published review | Source correction and acceptance status |
| --- | --- | --- |
| UX information architecture / UI04–UI06 / approved boards | Connected role navigation appeared above scrolling content. | Native layout owns scrolling content separately from fixed, safe-area bottom navigation for all four roles. Role-entry and matchday checks passed at 320/390px; further visual/device cases retain their own acceptance. |
| UI13/UI14/UI18 / WF02–WF03 | Elapsed time dominated the countdown; recording prose pushed the console down; primary actions scrolled away. | Fixed score/half countdown and explicit Start/manual clock/Goal/Substitute/Unavailable rail, independently scrolling pitch/forms/planner/details. Zero still never ends a half; every actual change retains its confirmation. |
| UI05 / UI22 | Closed ballots disappeared from Player Home instead of showing final/pending recognition. | Role-filtered home award card for awaiting result, review, final/joint/no-valid-votes and missed deadline. Private tallies remain absent. |
| UI06 | Player Schedule lacked match/training filters. | All/Matches/Training filters alongside Upcoming/Past, with truthful filtered empty states. |
| API06 / QL05 / UI21 | Connected spectators needed manual refresh. | Foreground active-game polling, separate slower related/history reads, bounded backoff, abort on background/scope/session change, fresh authorisation and exact terminal refresh. Recorder freshness never becomes viewer fetch time. |
| Q21 / ME54 / correction propagation | A retired completed-game refresh cache could retain an old score/policy after full time. | Second-pass finding: refresh loaded history without replacing pagination or letting retired cache override newer authorisation/corrections. Targeted tests cover denied policy and same-revision changes; current-source browser outcomes are recorded separately. |
| REP02 / F07 / F19 | Match RSVP was discarded in participation reports; own training/preferences could attempt a forbidden records write under restricted PostgreSQL. | Preserve preparation-response evidence, display RSVP separately from actual attendance, derive current own responses at read boundaries and retain manager-only records writes. Test own-only filtering, exports, exact retries and both database backends. |
| ME11/ME13/ME50 | Extreme finite monotonic values could exceed safe integer durations through retrospective correction. | Validate safe integer-millisecond ranges and accumulation while preserving ordinary fractional platform samples. Add malformed retrospective regression. |
| Reproducible build / SEC22 | Missing `db:migrate:check`, PR/development quality CI and retained scan/inventory procedures. | Real PostgreSQL migration command, source-secret scan with exact reviewed false-positive digests, dependency/licence inventory, registry audits, source/native/browser checks and separate production-image/operational exercises. Each later source/image needs its own observed result. |
| API04 / DS01 / report exports | Reports offered inline CSV/JSON, without the specified background export jobs, protected downloads or PDF. | Canonical 202 job/status/protected download, separate worker, current identity/role/policy/source checks and CSV/PDF are implemented alongside retained JSON/CSV compatibility. This is report export, not deferred account privacy fulfilment. |
| DS01 / agreed API stack | The service used direct Node HTTP dispatch although the specified stack names Fastify. | Integrated the agreed Fastify transport while preserving the exercised contract validation, permission boundaries and response behavior. The ee7cb613 full API run passed 367 checks with no skips; later changes require separate results. |
| Demo review quality / user direction | Numbered player labels, sparse schedule and repeated placeholder/demo copy made functional review less representative. | Generated named Roma squad and adult personas, eight fixtures and seven training dates; clean Demo/sample language. Explicit non-production demo option supplies sharing/voting examples and original people-free artwork through normal scanning/moderation. Stable IDs and existing journals are preserved. |
| UI01/UI03/UI31 / readable scope | Workspace and invitation review could make opaque identifiers the primary context. | Current authorised membership/token scope supplies club/team/age-group/season labels with secondary references. Role-only inviter labels avoid invented personal names. Exact IDs/roles retain authority; SQLite/restricted-PG rename/isolation tests passed within their targeted scope. |
| UI35 / denial recovery | Scope denial could close private views while stale identity hid recovery controls. | Current-ticket guards clear identity/current private caches and expose fresh identity refresh, preserving journals/outbox/pending requests. Late responses cannot close a new scope; transient failures are not denials. Browser regressions retain their actual run results. |
| API04 / binary HTTP | Mandatory wire-length equality rejected valid chunked or decoded compressed attachments. | Decoded stream cap/cancellation/lock release, optional length and equality only for explicit identity encoding; native fallback is capped before writing/sharing. Existing scope/MIME/disposition/cache checks stay enforced. |
| API04 / readable report | The generated PDF was valid but showed opaque context and technical flattened labels. | bb509f7 copies only bounded public labels from already-scoped preparation; PDF shows team/season/club, one Prepared timestamp and readable rows. Technical IDs/fingerprints stay out of PDF presentation; JSON/CSV compatibility, unknown/zero/policy/own-only and fingerprint invalidation remain. Focused PDF/HTTP 16 and shared 11 passed; queued-PDF browser rerun is pending. |

The 45-minute example ballot cutoff and demo-only sharing are test configuration, not approval of Q15/Q21. No real child data, photographs, new roles, paid service or permission widening is introduced.

## Scope reconciliation

All F01–F28 remain the integrated target. Source covers club/team/logo inheritance, seasons/rollover, profiles/snapshots/preferences, identity/roles/activation, fixtures/availability/training, formations/setup, clock/participation/planning/substitution/goal/availability rules, filtered reports, offline/control/history, spectator access, private awards, moderated media, results and historical entry. Recurring training, roster CSV import, selected calendar export and reusable match plans remain the four source-present Should features. The [build register](full-build-plan.md), [screen inventory](entry-completion-audit.md) and [traceability](traceability.md) separate source and proof from incomplete work.

That inventory does not complete SEC20/SEC21 privacy fulfilment or the operator support/recovery console. It does not establish every error/accessibility state, a passing performance target or native physical behaviour. No feature, native target, recorded football rule or deferred decision is silently removed or approved.

## Current source-bound verification

| Source / check | Observed result and limit |
| --- | --- |
| ee7cb613 aggregate | 741 shared/platform tests, 367 API tests without skips and 24 migration checks passed, with lint/root/mobile types/contracts and JavaScript/API exports. |
| ee7cb613 configuration/entry | Six evaluated native-configuration groups and six anonymous production-entry browser checks passed. Production web export passed; anonymous 390px DOM had no demo entry/seed, overflow, runtime error or recording IndexedDB. Native compile/device proof is separate. |
| Role/matchday/root browser | Role-entry 8 and matchday 6 passed at both widths. Root local 6, application 01–08, policy 2 and accepted-view 4 passed. Application 09 first timed out at entry for an unknown reason, then passed unchanged in isolation; the original failure is preserved. |
| bb509f7 focused work | Readable report PDF/actual SQLite/restricted-PG HTTP 16, shared records 11 and notification 49 passed. TypeScript/scoped lint passed. These overlap other suites; queued-PDF browser rerun and new full-source/publication results remain pending. |
| Dependency gate | Failed: two high build-tool advisories. Preserve exact upstream/version/path evidence and any separate moderate finding; runtime scans have separate scope. |

New source-bound evidence will be linked after packaging. Historical e899/c538/public/native/schema15 evidence does not certify later source or a new runtime image.

## Incomplete implementation and deferred decisions

**SEC20/SEC21 fulfilment is incomplete.** Request capture/status exists, but verified account export, retention-aware deletion/anonymisation, downstream processor/session/device/media revocation and restore-time deletion-ledger enforcement still need approved workflows and implementation. **The UI34 operator support/recovery case console is also incomplete.** Ordinary administrator access is not substituted for governed global authority. A request receipt never says data was erased.

The owner explicitly deferred **Q05/Q09/Q10 for later**. Continue sample-data functionality testing without appointing an operator, selecting a retention period or re-asking those deferred decisions. Other unresolved Q06/Q07/Q08/Q14/Q15/Q18/Q20/Q21 statuses remain in the [decision register](decisions.md); test defaults do not approve them.

## Failed targets and remaining acceptance

Every recorded QL04 load rehearsal has missed the 500ms p95 target. The first quiet 50-slot/1,000-request run accepted all requests but measured read p95 1,265.717ms and command p95 2,177.951ms. The latest bb509f7 run measured read p95 1,186.690ms and command p95 2,035.796ms. Retain all runs and failures with their source/scenario; a revised database-locking candidate awaits measurement; no passing target has been established. No local measurement establishes production/phone/battery or availability acceptance.

The dependency quality gate remains failed on two high build-tool advisories. No untested override or major upgrade is treated as a fix. Native signing/install, encryption restart/key loss/backup, sleep/kill/reboot timing, OS prompts/alerts/picker/share/system browser, large text/screen reader/outdoor use and battery require physical devices; the owner has deferred that testing.

Real identity/email/push, private hosting/storage, monitoring/support/moderation/recovery ownership, offsite 15-minute recovery point/four-hour recovery and monthly availability require their operating conditions and evidence. A temporary demo, configured source or local paired restore does not establish them. No paid service or real child-data environment has been introduced.

## Publication boundary

The public build is still c538419. Current-source Pages/API deployment, fresh readiness/expiry, queued-PDF browser proof and native CI must be recorded separately before declaring the new review published. Historical c538419 native Debug/unsigned Simulator successes remain historical; no installation or physical result is inferred. Final results will be added only from observed checks, with earlier failures intact.
