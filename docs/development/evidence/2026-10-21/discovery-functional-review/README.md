# Discovery transport functional browser review

All 18 named check groups passed in one fresh, unchanged complete rerun against product source `e899e29f71ac50de7de4c7737ee4eb907d7e7823`, which includes the bounded cache-key discovery fix. The accepted run had zero browser runtime errors and took 62.76 seconds across its four suites. It began at `2026-10-21T20:08:18.748592+00:00` and completed at `2026-10-21T20:09:21.538416+00:00`. This is not a first-run or no-retry claim.

The earlier combined attempt stopped during spectator entry at 320px with an unhandled Playwright `route.fetch` `ECONNRESET` on a records GET. The owned API remained healthy; an independent call to that same spectator records endpoint returned HTTP 200 with 4,046 bytes. A separately instrumented eight-role diagnostic then passed with 330 safe route/stage events, zero route errors, zero primary failures and no pending routes at any context close. The reset was not reproduced and a context-close cause was not proved. No product or tracked harness changes were made after that failure. The one unchanged complete rerun is the accepted 18-group result below; the diagnostic eight groups are not added to that count.

Each suite used a fresh isolated fictional SQLite HTTP service, real UI actions and normal service commands. Review discovery intercepts match only the exact pinned status endpoint with its bounded `reviewCheck` query; the returned fictional tunnel is forwarded to the owned loopback API. No application state was injected. These local intercepted checks do not independently prove public GitHub edge-cache freshness; implementation boundary and external transport evidence remain separate.

| Suite | Named groups | Scope | API port |
| --- | ---: | --- | ---: |
| [Role entry](role-entry.json) | 8 | Manager, administrator, player/household and spectator at 320 × 844 and 390 × 844; scoped data access and no horizontal overflow | 4392 |
| [Focused matchday](matchday.json) | 4 | Preparation gate, actual attendance, eligible lineup, focused navigation, kickoff and referee pause; independent accepted-state HTTP reads | 4393 |
| [Policy and handover](policy-handover.json) | 2 | Canonical policy acceptance, addressed handover, preserved history and recipient policy acceptance without active time | 4394 |
| [Accepted manager view](accepted-view.json) | 4 | Read-only accepted pitch/list/bench and static clock at 320px; local request sends no POST; forbidden write and wrong-device transfer denied; correct recipient accepts epoch 2; former recorder is read-only at 390px | 4395 |

All four reports captured these artifacts before the journey and verified the same hashes afterward, binding the supplied source revision rather than a later repository HEAD:

- Web: `/_expo/static/js/web/index-41ad15fa0a5993656c0efd5cf072c5ce.js`, 1,486,641 bytes; SHA-256 `6197af1b94e092646bdb866d2f1a2c6bc0591bf64a13781a51e36c6c8f73aa2b`.
- API: `apps/api/dist/api.mjs`, 782,954 bytes; SHA-256 `d1568c20879d2e1df83843fc31e35a6fa053751785560988f53093c546e10798`.

The manifest also binds `apps/api/dist/media-worker.mjs`, 3,467 bytes, SHA-256 `4b878815f5255ec427900db496df40c278176e381bfc3b7f6809912fe4cea5ed`, before and after every suite. This is a checksum binding only; these groups do not exercise media processing.

[summary.json](summary.json) and [manifest.json](manifest.json) are exact aggregate copies and explicitly preserve the earlier failure and diagnostic execution history. Their `.local/final-verification/discovery-e899e29f-20261021T200818Z-rerun1/` paths describe private runtime files; the four accepted reports are copied alongside this README under the linked names. Initial failed output and diagnostic traces remain private at `.local/final-verification/discovery-e899e29f-20261021T200210Z/`. No raw API logs, databases, browser journals or credential headers are included. All owned API listeners were closed after execution.

The previous [pre-transport product evidence](../final-functional-review/README.md) remains unchanged and binds its historical `7ede8d1e` artifacts. It is not relabelled as this cache-fix result.

The two inspected screenshots show the approved white/green direction and fictional Roma U10 data:

- [Player/household home at 390px](player-390.png): availability replies stay distinct from selection and actual attendance.
- [Manager schedule at 320px](manager-320.png): compact role navigation, calendar copy and explicit schedule controls.

This is browser evidence with public fictional review identities. It does not prove physical iPhone/Android behavior, native encrypted storage or sharing, provider authentication, running-device clock transfer, push delivery or a configured production service. Policy gates remain unchanged; unapproved Q07 keeper transitions remain refused. Native configuration and build evidence are recorded separately.
