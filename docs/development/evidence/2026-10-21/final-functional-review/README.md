# Final functional browser review

All 18 named check groups passed on the first run, with zero browser runtime errors and no suite retries. This evidence exercises final product source `7ede8d1ef944823cfd6a5f6965ab51d4c37d286e`; it does not infer the tested source from a later operational or evidence commit.

The run began at `2026-10-21T19:32:33.944878+00:00` and completed at `2026-10-21T19:34:32.894518+00:00`; the four suites took 118.94 seconds in total. Each used a fresh isolated fictional SQLite HTTP service, real UI actions and normal service commands. Only published review-service discovery was redirected to the owned loopback API. No application state was injected into the browser.

| Suite | Named groups | Scope | API port |
| --- | ---: | --- | ---: |
| [Role entry](role-entry.json) | 8 | Manager, administrator, player/household and spectator at 320 × 844 and 390 × 844; scoped data access and no horizontal overflow | 4392 |
| [Focused matchday](matchday.json) | 4 | Preparation gate, actual attendance, complete eligible lineup, focused navigation, kickoff and referee pause; independent accepted-state HTTP reads | 4393 |
| [Policy and handover](policy-handover.json) | 2 | Canonical policy acceptance, explicit addressed handover, preserved policy history and recipient policy acceptance without active time | 4394 |
| [Accepted manager view](accepted-view.json) | 4 | Read-only accepted pitch/list/bench and static clock at 320px; local request panel sends no POST; forbidden write and wrong-device transfer denied; correct recipient accepts epoch 2; former recorder is read-only at 390px | 4395 |

The four suite reports captured these artifacts before the journey and verified the same hashes afterward:

- Web: `/_expo/static/js/web/index-0e10e3d0fbd5528d8ee4e090a5d1e659.js`, 1,486,506 bytes; SHA-256 `c007d2543cbff4ce46c1eded82f8ce9d485b2dba7b2fa68f25e1eee7e2e126c7`.
- API: `apps/api/dist/api.mjs`, 782,954 bytes; SHA-256 `d1568c20879d2e1df83843fc31e35a6fa053751785560988f53093c546e10798`.

The manifest also binds `apps/api/dist/media-worker.mjs`, 3,467 bytes, SHA-256 `4b878815f5255ec427900db496df40c278176e381bfc3b7f6809912fe4cea5ed`, before and after each suite. This is a checksum binding only: these 18 groups do not exercise media processing or establish the media retry fix independently.

[summary.json](summary.json) and [manifest.json](manifest.json) are exact copies of the original aggregate files. Their `.local/final-verification/final-7ede8d1e-20261021T193233Z/` report paths describe the private runtime location; the four corresponding reports are copied alongside this README under the names linked above. Raw API logs, service databases, browser journals, prior `55465b04` proof and `initial-1d11987` diagnostics remain ignored and are not included. Earlier passes or failures are not evidence for this final API artifact. All four owned API listeners were closed after the run.

The two screenshots show the final approved white/green layout with fictional Roma U10 data. Both were inspected for readable content and narrow-phone layout:

- [Player/household home at 390px](player-390.png): availability replies remain distinct from selection and actual attendance.
- [Manager schedule at 320px](manager-320.png): compact role navigation, calendar copy and explicit schedule controls.

This is browser evidence with public fictional review identities. It does not prove physical iPhone/Android behavior, native encrypted storage or sharing, provider authentication, running-device clock transfer, push delivery or a configured production service. Policy approval gates remain unchanged; unapproved Q07 keeper transitions remain refused. Native configuration/build evidence is recorded separately.
