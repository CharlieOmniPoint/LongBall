# Review LongBall

21 October 2026. Development branch: `dev/longball-m0-journey`; draft [PR1](https://github.com/CharlieOmniPoint/LongBall/pull/1). The application preserves native iPhone/Android and the complete agreed F01–F28 scope. The [feature register](full-build-plan.md) records implemented journeys and remaining release gates. Physical M0 and production acceptance remain incomplete.

## Browser review

Open and share [the lasting fictional review](https://charlieomnipoint.github.io/LongBall/). GitHub Pages deployment succeeded after the owner enabled Actions publishing and allowed `preview/longball-m0`. An external 390×844 browser passed the actual attendance → lineup → start → pause journey and static API-address guards, without browser exceptions, failed responses or horizontal overflow. This static build uses each browser's own fictional records, without a shared backend. Clearing storage, eviction or private browsing can lose those records.

The combined browser/API review uses a separate temporary HTTPS session. Its URL, source, state and expiry are in `preview/longball-m0:preview-status.json`; only `ready` before expiry is usable. Free runner sessions last one hour, have temporary databases and receive new addresses when renewed. An expired tunnel is not a lasting review link. No Windows setup, Sites project or paid service is required.

All Roma U10 players, accounts, matches and illustrations are fictional. The public review selectors confer no access to real children or teams.

1. **Home → Prepare match:** explicitly check in selected players, continue to lineup, place starters, inspect pitch/list view and start. Availability replies do not establish attendance. Pause/resume and both half endings are deliberate. Zero continues into added time; actual first-half length does not change the planned second half.
2. **Schedule / Team / Settings:** create and reschedule fixtures, maintain training, record separate replies and attendance, edit profiles/preferences/eligibility, save 5–11-place formations and prepare immutable match snapshots.
3. **Live / Planner:** review proposals before confirmation; record goals/own goals, corrections/voids, late arrivals, departures/returns and explicit vacancies. Abandonment preserves history. Suggestions never move children automatically.
4. **Reports / More:** inspect participation and unknown historical evidence, ordinary 3/1/0 results, own-player/spectator views, invitations, private ballots and moderated exact-revision illustrations. Shared U10 scores and derived disclosures remain withheld without the Q21 audience policy.
5. **Connected service:** enter the API address explicitly on the static review, or use `/` on the combined API session. The distinct workspace exercises actual server reads/writes, reports/downloads, staff and season administration, scoped photo albums, controller capture/retry/handover and retained conflicts. Ordinary local review actions are not silently uploaded as accepted service history.

Each browser origin has independent storage. Browser reload/backgrounding cannot prove native clock continuity or encryption. Uncertain pending requests and conflicting branches remain reviewable. A real-account browser workspace uses memory for private data; it cannot claim the protected native recording cache.

## Run in cloud Codex or locally

```bash
cd /workspace/LongBall
bash scripts/setup.sh                 # fresh workspace only
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

Open `http://127.0.0.1:4310` on that machine. Cloud localhost is not a desktop sharing address. Start the worker with `pnpm dev:worker` against the same database. Use [the restricted PostgreSQL runtime](../../infra/runtime/README.md) for the disposable deployment rehearsal and [identity trial](../../infra/identity/README.md) for actual loopback HTTPS Keycloak testing. Neither provisions paid hosting.

`pnpm dev` starts Metro for a custom native development client; phones need a reachable Metro/API host. Expo Go cannot exercise SQLCipher. A production web export uses `EXPO_PUBLIC_ENVIRONMENT=production pnpm --filter mobile exec expo export --platform web --output-dir dist-production-review`; it requires connected sign-in and contains no fictional identity selectors. Provider/client/redirect configuration is explicit; credentials never belong in public Expo variables.

## Evidence

The original expanded checkpoint (219 unit,79 API and25 local browser checks) is preserved under [expanded evidence](evidence/2026-10-21/expanded/checkpoint.json). It is historical and does not validate later source changes. The published source `79cbc724` checkpoint passed 332 shared/platform and 143 API/access/worker tests. The later security increment passed 355 shared/platform tests in 38 files and 169 API/access/worker tests in 20 files, including actual PostgreSQL, alongside lint, typechecking, contracts, web/API exports and both native JavaScript bundles. The final API run started at 11:11:21 UTC and took 99.99 seconds; an earlier overloaded run had two real processing timeouts, preserved in the local diagnostic log. No timeout limit or decoder check was weakened. Migration009 uses the database clock for claims and award fanout, and rejects future-dated legacy lease capabilities. Database business effects and completion settle atomically; an expired or superseded lease cannot commit a partial result. The refreshed schema9 image passed separate migration, restricted API/worker boot and 12 API/15 worker permission checks. Exact-source publication remains pending.

| Check | Executed evidence and limit |
| --- | --- |
| Canonical pack/contracts | All 15 supplied archive members and 14 checksums preserved; six fairness vectors, full canonical OpenAPI 3.1 and separate runtime extension 1.2 validate. Runtime YAML rejects duplicate keys. |
| Match/application browser | Current bundle `75a10e90d5fc1f821ab8fc53e5297c93` passed 10 original match, 6 live-event and 9 application checks at 10:56 UTC. Actual controls and durable records were inspected without injected domain state. Browser time acceleration is not a physical50-minute rehearsal. |
| Connected history/controller | Five HTTP/browser journeys passed on the preceding `574b3e4289da41fb548779d3b27caa53` bundle, including post-full-time audited participation repair, held-prefix suffix capture, exact retries, epoch handover/quarantine and durable proposal recovery. [Evidence](evidence/2026-10-21/history-review/README.md). Final reconciliation remains unavailable pending Q08 authority. |
| Connected records/access | Five HTTP/browser cases passed: rich history/unknowns, accepted match context/archive and actual JSON/CSV downloads, explicit rollover/source preservation, delayed scoped denial/cache closure and membership-free invitation acceptance. [Evidence](evidence/2026-10-21/connected-rich-4108/summary.json). |
| PostgreSQL/operations | Actual PostgreSQL 18.6 verifies SEC10 RLS on 28 account/tenant tables, 23 composite foreign keys, short transaction-local verified contexts and purpose-bound non-bypass API/worker roles. Twelve focused security/privacy checks, 19 notification checks (12 actual PostgreSQL, 7 SQLite) and three restricted HTTP cases passed; paired schema9 `pg_dump`/`pg_restore` preserved exact private derivatives. Earlier actual ClamAV and metadata-stripping proofs remain valid for those unchanged paths. Database-clock claims and rejection of future-dated legacy lease capabilities passed regression checks; the refreshed schema9 image passed restricted API/worker startup and permission checks. This is not a hosted service, capacity result or offsite recovery SLA. [Evidence](evidence/2026-10-21/runtime/README.md). |
| Identity | Ten real Keycloak 26.8.1 checks passed, including password/recovery setup, cancellation/replay, PKCE, refresh/revocation, adult TOTP and API child activation requiring the original token. Four actual privacy API checks passed under RLS; five identity/activation checks passed after schema7 migration. Local HTTPS trust and explicit trial policy do not approve production recovery, hosting or phone redirects. [Evidence](evidence/2026-10-21/identity/). |
| Notifications/media | Durable generic notification jobs check fresh audience/preferences and quiet hours; no real device delivery is claimed. Actual scanner and derivative tests do not establish ongoing updates or moderation operations. |
| Production entry | Four checks passed on latest export `958b34f7798e83afa33267fbcc97d832`: sign-in required, no fictional seed, no anonymous recording journal, 390px layout without runtime errors. |
| Hosted static review | Public [GitHub Pages](https://charlieomnipoint.github.io/LongBall/) passed the attendance/lineup/start/pause and static API-address guard journey at 10:50:38 UTC, 390×844, on bundle `1f994eab9ecd0cbe816e06ec65de3984`. No browser exceptions, failed responses or horizontal overflow. This is the published `79cbc724` source, before later security changes. |
| Storage guards | Three actual corrupted-journal/reopen/Retry browser cases preserved complete serialized journals, events and checkpoints. These prove fail-closed retained records; they do not explain every earlier startup/click timeout. [Evidence](evidence/2026-10-21/storage-guards/README.md). |
| Native compilation | Both Android debug and unsigned iOS Simulator compiled at source `79cbc724d5cc63a8331b5f10eeabe6f5d2c3fc4e` in [run39582846991](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39582846991): Android at 10:18:28 UTC and iOS at 10:22:34 UTC. Later JavaScript/security changes passed both native JavaScript exports; compiled binaries were not retained. No physical-device behaviour is proved. |

Browser commands are `node scripts/browser-review.mjs`, `node scripts/live-review.mjs`, `node scripts/application-review.mjs`, `node scripts/connected-review.mjs`, `node scripts/connected-records-review.mjs`, `node scripts/pages-review.mjs` and `node scripts/production-entry-review.mjs`. Reports/screenshots are written to ignored `.local/`; selected sanitized results are preserved in the evidence register. Production entry expects4174; the local review expects4173; connected suites use isolated API databases/ports.

## Incomplete release work

Database row-level tenant isolation required by SEC10 is implemented and has passed the focused schema9 security and restore proofs. The refreshed schema9 image passed restricted startup and permission checks; exact-source publication remains an engineering check. A full-scope audit also identified four implementable requirements now assigned for the next increment: uploaded club/team logos (F01), new spectator invitee credential activation and hash-only invitation tokens (SEC12), OS biometric/device authentication for local unlock (SEC05), and own native-device enrollment and inventory (UI33). These are engineering work, not owner policy decisions. The current public review remains fictional.

The [native M0 proof register](implementation-scope.md#native-m0-proof-register) requires physical iPhone and Android testing: SQLCipher and wrong-key/key-loss/backup behaviour, sleep/lock/kill/reboot timing,50-minute drift, offline recovery, Focus/battery/permission-denied notifications, native file sharing and photo picker/cache, outdoor/large-text/accessibility.

[Unapproved decisions](decisions.md) remain explicit: recovery and reconciliation authority, privacy/retention/injury treatment, operating ownership, exceptional match rules and U10 result audiences. Account requests can be submitted and tracked; that does not fulfil deletion/export, choose a retention period or erase records. Real push delivery, production identity/private storage, operational monitoring/offsite recovery, signed distribution and pilot acceptance remain incomplete. No real child data, paid resources, store enrolment or production release is introduced.
