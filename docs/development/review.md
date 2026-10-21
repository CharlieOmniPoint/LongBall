# Review LongBall

21 October 2026. Development branch: `dev/longball-m0-journey`; draft [PR1](https://github.com/CharlieOmniPoint/LongBall/pull/1). The application preserves native iPhone/Android and the complete agreed F01–F28 scope. The [feature register](full-build-plan.md) records implemented journeys and remaining release gates. Physical M0 and production acceptance remain incomplete.

## Browser review

The lasting fictional review is prepared at `https://charlieomnipoint.github.io/LongBall/`. The owner enabled GitHub Actions publishing; do not treat this address as live until the deployment and public check are recorded. This static build uses each browser's own fictional records, without a shared backend. Clearing storage, eviction or private browsing can lose those records.

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

The original expanded checkpoint (219 unit,79 API and25 local browser checks) is preserved under [expanded evidence](evidence/2026-10-21/expanded/checkpoint.json). It is historical and does not validate later source changes. The new broad checkpoint passed332 shared/platform tests (37files) and143 API/access/worker tests (17files), including actual PostgreSQL. Bundle identities and publication results are recorded with the new review checkpoint.

| Check | Executed evidence and limit |
| --- | --- |
| Canonical pack/contracts | All15 supplied archive members and14 checksums preserved; six fairness vectors, full canonical OpenAPI3.1 and the separate maintained runtime extension validate. Runtime YAML rejects duplicate keys. |
| Match/application browser | Latest bundle `574b3e4289da41fb548779d3b27caa53` passed10 original match,6 live-event and9 application checks. Actual controls and durable records were inspected without injected domain state. Browser time acceleration is not a physical50-minute rehearsal. |
| Connected history/controller | Five HTTP/browser journeys passed on that bundle, including post-full-time audited participation repair, held-prefix suffix capture, exact retries, epoch handover/quarantine and durable proposal recovery. [Evidence](evidence/2026-10-21/history-review/README.md). Final reconciliation remains unavailable pending Q08 authority. |
| Connected records/access | Five HTTP/browser cases passed: rich history/unknowns, accepted match context/archive and actual JSON/CSV downloads, explicit rollover/source preservation, delayed scoped denial/cache closure and membership-free invitation acceptance. [Evidence](evidence/2026-10-21/connected-rich-4108/summary.json). |
| PostgreSQL/operations | Actual PostgreSQL18.6 transaction/HTTP/role checks, signed-database ClamAV, bounded metadata-stripping derivatives, rollback and paired `pg_dump`/`pg_restore` plus object hashes passed. The read-only non-root API/worker rehearsal verifies restricted runtime roles. This is not a hosted service, capacity result or offsite recovery SLA. [Evidence](evidence/2026-10-21/runtime/README.md). |
| Identity | Nine isolated real Keycloak26.8.1 checks passed, including password/recovery setup, cancellation/replay, PKCE, refresh/revocation, adult TOTP and restricted API child activation. Local HTTPS trust and explicit trial policy do not approve production recovery, hosting or phone redirects. [Evidence](evidence/2026-10-21/identity/). |
| Notifications/media | Durable generic notification jobs check fresh audience/preferences and quiet hours; no real device delivery is claimed. Actual scanner and derivative tests do not establish ongoing updates or moderation operations. |
| Production entry | Four checks passed on export `a3ec3741c511df6df4452e267ddf4e1c`: sign-in required, no fictional seed, no anonymous recording journal,390px layout without runtime errors. |
| Native compilation | Both Android debug and unsigned iOS Simulator compiled at source `36223f7` in [run39561530615](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39561530615). This precedes the new increment; fresh native compilation is required for it. No physical-device behaviour is proved. |

Browser commands are `node scripts/browser-review.mjs`, `node scripts/live-review.mjs`, `node scripts/application-review.mjs`, `node scripts/connected-review.mjs`, `node scripts/connected-records-review.mjs`, `node scripts/pages-review.mjs` and `node scripts/production-entry-review.mjs`. Reports/screenshots are written to ignored `.local/`; selected sanitized results are preserved in the evidence register. Production entry expects4174; the local review expects4173; connected suites use isolated API databases/ports.

## Incomplete release work

Database row-level tenant isolation required by SEC10 is being implemented alongside current application object checks and restricted database roles. It is an engineering requirement, not a pending owner policy decision. The current public review remains fictional.

The [native M0 proof register](implementation-scope.md#native-m0-proof-register) requires physical iPhone and Android testing: SQLCipher and wrong-key/key-loss/backup behaviour, sleep/lock/kill/reboot timing,50-minute drift, offline recovery, Focus/battery/permission-denied notifications, native file sharing and photo picker/cache, outdoor/large-text/accessibility.

[Unapproved decisions](decisions.md) remain explicit: recovery and reconciliation authority, privacy/retention/injury treatment, operating ownership, exceptional match rules and U10 result audiences. Account requests can be submitted and tracked; that does not fulfil deletion/export, choose a retention period or erase records. Real push delivery, production identity/private storage, operational monitoring/offsite recovery, signed distribution and pilot acceptance remain incomplete. No real child data, paid resources, store enrolment or production release is introduced.
