# Review LongBall

Current published product: `d07cf42ae04b17ff6c00f1d84f2e5c8bed2a9114`. Super Admin can now see application-wide login and activity reports, split by club, team, account type, event and time period. Existing native iPhone/Android targets, phone/tablet layouts, roles, Roma squad and credentials are preserved. Production, dependency-security, privacy/support and physical-device gates remain open.

## Shared review status

Open [LongBall](https://charlieomnipoint.github.io/LongBall/?review=d07cf42), refresh and sign in again. Super Admin can open **Clubs → Login activity** or the entry under **More**. The purple dashboard shows active accounts, successful/unsuccessful sign-ins, account mix, club/team breakdowns and a paginated event timeline. Filters stay collapsed until needed; phone and tablet layouts have separate density. [Definitions and coverage](login-activity.md).

An active account has made an authenticated API request within 15 minutes; automatic foreground checks count as activity. The report checks every minute while open and displays its last successful UK-time receipt. Automatic refresh pauses while browsing older event pages. Historical events retain access membership at observation time, rather than claiming actual team-page visits. Tracking starts with collection; earlier login events are not invented.

[Public deployment verification](evidence/2026-10-25/login-activity/publication.json) confirms the exact source and served JavaScript checksum, current service discovery, API health, public sign-in rules, visible login form and unauthenticated report denial. No account credentials were sent to the remote browser. [Artifact comparison](evidence/2026-10-25/login-activity/packaged-artifact-comparison.json) proves that Pages differs from the tested browser bundle only by the 44-byte Expo base-path manifest entry; packaged API/worker bytes match tested binaries. The separate runtime-hosted web entry has its own profile and is not claimed byte-identical. All twelve existing verifier values are unchanged.

The connected free service expires at **20:24:56 GMT on 25 October 2026** (`20:24:56 UTC`). The Pages address persists. Renewal starts a fresh seeded database. No paid analytics/infrastructure service or production identity provider was provisioned.

[Current local evidence](evidence/2026-10-25/login-activity/README.md): 955 shared/client tests; 495 API passes plus three explicit absent-HEIC-helper skips using SQLite/restricted PostgreSQL; 45 actual PostgreSQL migration checks; nine new reporting browser groups; and eight existing role/width journeys with 28 checks passed. Full lint, TypeScript, canonical/runtime contracts including 438 new reporting boundary cases, packaging and source secret checks passed. Earlier failures retain their original outcomes. [Actual Android Debug and unsigned iOS Simulator compilation](evidence/2026-10-25/login-activity/native-final.json) passed for the published source. [Source-equivalent PR CI](evidence/2026-10-25/login-activity/ci-final.json) passed substantive functional, migration, export and browser steps, including 36 tablet journeys/three groups and seven expansion groups. Production-image acceptance passed. Overall CI failed only dependency enforcement; its narrow gate reports a failed or unavailable workspace audit, not a verified advisory-only cause. Existing dependency findings remain unwaived. Browser checks and compilation do not establish physical-device acceptance.

The known unwaived dependency-security findings and owner-deferred Q05/Q09/Q10 remain open. Super Admin reporting does not approve production retention/support decisions or infer human presence from a shared account. See the remaining owner/device work below.

## Previous sign-in rules release

The following account-rules evidence belongs to product `43bf93d`; its original deployment expiry and source-qualified counts remain historical.

Previously published product: `43bf93d5e0d8f076936abb453ae5d572f620eeaf`. The update adds application-wide Super Admin sign-in rules, team-based first usernames, and visible automatic match-refresh status. It preserves the native iPhone/Android targets, phone/tablet browser layouts, original feature scope, five account types and the owner's eight-player Roma U10 squad. Existing credentials remain valid. Production, dependency-security, privacy/support and physical-device gates remain open.

### Previous shared review status

Open [the updated LongBall demo](https://charlieomnipoint.github.io/LongBall/?review=43bf93d), refresh the page and sign in. Super Admin can open **Clubs → Manage sign-in rules**. Shared Match Centre views show the last successful check in UK time, check idle matches every two minutes, and retain faster live-game updates. New named account flows suggest names such as `Roma.SebL`; existing usernames are unchanged. [Behaviour, provider enforcement and namespace limits](sign-in-rules-and-refresh.md).

[Publication proof](evidence/2026-10-25/sign-in-rules/publication.json) records the Pages deployment, exact served JavaScript checksum and public API/policy checks. No account credential was sent to the remote browser. The [packaged artifact comparison](evidence/2026-10-25/sign-in-rules/packaged-artifact-comparison.json) proves that Pages differs from the locally tested JavaScript only by the 44-byte Expo `/LongBall` base-path manifest entry; packaged API/worker bytes match the tested binaries. All 12 demo verifier values are unchanged.

The connected service expires at **18:05:56 GMT on 25 October 2026** (`18:05:56 UTC`). The Pages address persists. This remains the bounded free demo service; renewing it starts a fresh seeded database. No paid infrastructure or production identity provider was provisioned.

[Current local evidence](evidence/2026-10-25/sign-in-rules/README.md): 932 shared/client tests; 475 API passes plus three explicit HEIC-helper skips with actual SQLite/restricted PostgreSQL; eight role/width browser journeys and 28 checks; seven expansion groups including 390px purple policy controls, exact-key save retry and username suggestions; six Java provider checks and seven adapter checks. TypeScript, final full lint, canonical/runtime contracts, 141 policy cases, 129 expansion cases, packaging, source secret scanning and both native Hermes exports passed. Earlier failures and narrowly bounded harness transport changes remain in the evidence rather than being relabelled as passes.

[Current-source CI](evidence/2026-10-25/sign-in-rules/ci-snapshot.json) passed functional, migration, browser, tablet, expansion and production-image checks. [Actual Android Debug and unsigned iOS Simulator compilations](evidence/2026-10-25/sign-in-rules/native-final.json) both passed for product `43bf93d`. The earlier dated CI snapshot retains its then-pending iOS status; the later native report records completion. Overall CI failed only the unwaived dependency enforcement step. Provider realm setup/reset and physical-device acceptance are separate from compilation and local unit/browser checks. The unwaived high `node-forge` and `zod` dependency findings and owner-deferred Q05/Q09/Q10 decisions remain outstanding.

The sections below retain the source-qualified history of the earlier club expansion (`194e6cf`) and its validation. They are not substituted for current-source test counts or publication proof.

## Corrections verified in the published product

Actual SQLite/PostgreSQL checks found that coach revocation could target a Super Admin’s inherited Manager row and freeze its controller/preparation access while the administrative grant remained. The corrected route rejects inherited rows; administration-grant removal remains separate. Append-only PostgreSQL migration 024→025 also restricts direct inherited-row updates. Original migration 021 is unchanged. PostgreSQL is schema 25 with 45 RLS tables; SQLite remains schema 11. Five focused authority/migration checks and the subsequent full corrected-source API suite passed.

The preceding full API attempt had 458 passes, three HEIC-helper skips and one concurrent SQLite first-open WAL failure. The narrow correction retries only WAL `BUSY`/`LOCKED` against a monotonic five-second deadline, restores the normal busy timeout, and does not retry arbitrary errors or whole migrations. The [original working-tree stress report](evidence/2026-10-24/club-expansion/wal-startup-stress.json) preserves its old HEAD/dirty-tree metadata: 80/80 synchronized startups across 20 databases passed; a held lock was refused at 5001ms and a corrupt database immediately. Nested `passed: false` fields describe those expected refusals. The final committed-source CI separately passed 459 API cases and 30 migration checks.

## What the expansion adds

[The expansion register](club-expansion.md) records the full behaviour and authority boundaries.

- **Formation and advice:** choose playing format, type a traditional outfield pattern such as `4-4-2` or `3-2-1`, and review a positions-only pitch. Available eligible players and ranked preferences inform reviewable 65% primary / 35% secondary advice; impossible allocations remain visible and no player is moved automatically.
- **Five account types:** Super Admin, Club Admin, Manager, Player and Spectator. Club/system authority is server-owned; inherited Manager access is separate from the four appointed coach places. Club/team/season selection, U5–U21 teams, optional league names and sortable/filterable club reports follow current scope.
- **Spectator access:** scoped invitations can be shared as locally generated QR/link or composed email. First registration uses a username/four-digit PIN with weak-code refusal and bounded login/lockout. Spectators may join multiple teams and choose a player to support without receiving private Player records. An unauthenticated Player/Spectator access request grants no account or membership. [Access notes](spectator-access.md).
- **Team records:** genuine XLS roster download/previewed import preserves player identities; own/Manager FA IDs and staff-only validated PDF team sheets keep their scope. Known goalkeeper clean sheets come from accepted stint/goal evidence. Completed-game opposition ratings/notes are staff-authored, Player-readable and Spectator-denied.
- **Match-day controls:** a prominent next-substitution countdown lists the advised changes, with saved lead/volume settings and explicit per-device audio enablement. Substitutions remain manual; pause, uncertainty, stale advice and control/background changes suppress inappropriate tones. [Audio/device limits](substitution-alerts.md).
- **Presentation:** Spectator blue and Super Admin purple themes, team/context navigation and phone/tablet modes remain accessible. The compact match layout passed both timer geometry and active/pause checks at 320px and 390px.

## Checks and limits

[The evidence register](evidence/2026-10-24/club-expansion/README.md) preserves original report/source/time fields. [Corrected-source CI](evidence/2026-10-24/club-expansion/ci-194e6cf.json) verified a checkout tree identical to published product `194e6cf`:

| Check | Observed result / boundary |
| --- | --- |
| Shared/API | 914 shared/platform tests in 110 files; 459 API passes plus three explicit absent-HEIC-helper skips (462 total, 75 files). Actual PostgreSQL boundaries were exercised; no full zero-skip helper run is claimed. |
| Migrations/static/contracts | 30 checks in six migration files, TypeScript/lint, canonical/runtime contracts, supplied-archive preservation, 127 new contract boundary cases and source publication passed. The separate production-image acceptance job passed. |
| Compiled browser | [Six expansion groups](evidence/2026-10-24/club-expansion/expansion-browser-194e6cf.json), [eight role/width journeys and 27 groups](evidence/2026-10-24/club-expansion/demo-browser-194e6cf.json), plus CI’s ten M0 and 36 tablet/two composite checks passed. Both timers were visible/unclipped at 320/390px; the substitution timer decreased in play and froze while paused without changing lineup/revision/outbox. The labelled mocked terminal-summary GET retains its client-projection scope. |
| Tablet lifecycle follow-up | [The follow-up maintained harness](evidence/2026-10-24/club-expansion/tablet-followup-194e6cf.json) passed 36 viewport journeys/three groups and 12 logins, with zero unexpected failures and one deliberate captured-old-session GET denial. Its report explicitly retains dirty-test/evidence scope and a different harness hash; deployed product bytes are unchanged. [The original failed local attempt](evidence/2026-10-24/club-expansion/tablet-original-failure-194e6cf.json) remains failed, with its eight request timings unknown. |
| UK-midnight follow-up | [The date-aware demo](evidence/2026-10-24/club-expansion/demo-date-aware-194e6cf.json) again passed eight journeys/27 groups and [expansion](evidence/2026-10-24/club-expansion/expansion-date-aware-194e6cf.json) six groups after London midnight. Tests selected the 24 October fixture from Past and created one future fixture only in an isolated database; original four seed fixtures were unchanged. [Fingerprints](evidence/2026-10-24/club-expansion/date-aware-assets-194e6cf.json) retain dirty-test/harness scope against unchanged deployed artifacts. |
| Public review | Actual deployed JavaScript matches the packaged checksum; four previously approved public account journeys passed. The fifth account’s compiled local journey is recorded separately. |
| Native | [Android Debug arm64 and unsigned x86_64 iOS Simulator compilations](evidence/2026-10-24/club-expansion/native-194e6cf.json) passed for exact source `194e6cf`, with native security/configuration guards and Hermes exports. No binary was retained; signing, installation/launch and device/audio acceptance are not established. |
| Secrets/dependencies | Source scan passed 1,188 files with zero unexpected findings and 63 exact reviewed checksum false positives. Overall CI **failed** the enforced workspace dependency gate; `node-forge` and `zod` remain two unwaived high findings. Separate runtime/compiler audits passed with zero for their captured locks. |

[Dependency evidence and compatible-update investigation](club-expansion-security.md) retain their original captured lock/source scope. Functional and isolated audit passes do not waive the full gate. Earlier [aeefdbf](evidence/2026-10-24/club-expansion/local-evidence-aeefdbf.json), [e706/38e](evidence/2026-10-24/past-game-replies/README.md), [tablet](evidence/2026-10-24/tablet-layout/README.md) and other reports remain historical; neither their older totals nor one-high labels are relabelled as this release. No paid provider or production service was provisioned.

## Deferred owner and device work

At the owner's instruction, Q05/Q09/Q10 verification, retention and support authority remain pending. SEC20/SEC21 privacy fulfilment and UI34 governed support/recovery therefore remain incomplete. Demo settings and fixtures do not approve production operating or audience policies.

Physical iPhone/iPad/Android testing is deferred. Tablet rotation, split view, on-screen/hardware keyboards and screen readers still need device evidence. Background timing, encrypted storage/backup exclusion, OS authentication/prompts, notifications, battery/Focus behavior and signing/installation still require their own evidence. Production identity, storage, delivery and operating services have not been provisioned. This review is for generated-data functionality feedback.

Historical source proofs remain in the [build register](full-build-plan.md), [earlier public account review](evidence/2026-10-24/public-account-review/README.md), [workflow checkpoint](evidence/2026-10-23/workflow-retention/README.md), [traceability](traceability.md) and [decision register](decisions.md).

## Run in the development workspace

```bash
cd /workspace/LongBall
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

The development API defaults to `http://127.0.0.1:4310` on that machine. Cloud localhost is not a sharing address. Saved CSV/PDF exports additionally require the separate worker using the same database, export key and TTL; see [protected reports](report-exports.md) and [runtime setup](../../infra/runtime/README.md). Device and dependency gates remain separate from `pnpm check`.
