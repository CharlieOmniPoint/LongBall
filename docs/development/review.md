# Review LongBall

21 October 2026. Development branch: `dev/longball-m0-journey`. This is the expanded fictional development build following the initial M0 journey. It preserves native iPhone/Android and the complete agreed F01–F28 target. The [feature register](full-build-plan.md) separates implemented controls, connected service integration and remaining release gates. Physical M0 and production release are incomplete.

## Cloud review

Use the verified HTTPS session linked in the chat. Its current URL, state, source revision, Actions run and expiry are recorded in `preview/longball-m0:preview-status.json`; only `ready` before expiry is usable. A new build/session has a new address. The free runner session lasts up to one hour and its database is temporary. Development source remains in cloud Codex and the development branch. No Windows setup, Sites project or paid service is required.

The default app is a local fictional manager rehearsal. **More → Connected service** opens a distinct HTTP-backed workspace and controller rehearsal; local actions are not silently uploaded into accepted service history. Public fictional account selectors grant no access to real users or data. All Roma U10 players, matches, images and accounts are synthetic.

1. **Home → Prepare match:** explicitly check in selected players; availability replies do not establish attendance. Continue, place starters, tap a pitch place or use list view, then start. Pause/resume and both half endings are deliberate. Zero continues into added time; the second planned half is unchanged by the actual first half.
2. **Schedule / Team / Settings:** create and reschedule fixtures, maintain training occurrences, record distinct replies and attendance, edit profiles/preferences/eligibility, save 5–11-place formations and prepare immutable match snapshots. Existing recorded matches are not reset by later preparation edits.
3. **Live / Planner:** review proposals before confirming changes, record goals/own goals, late-entry times, corrections/voids, availability departures/returns and explicit vacancies. Abandonment retains actual history. Planner results distinguish validated candidates, proved impossibility and an indeterminate budget limit; no suggestion moves a child automatically.
4. **Reports:** inspect detailed participation, own records, historical results and corrections. Missing historical minutes/attendance stay unknown. Ordinary completed games, including friendlies, use 3/1/0. Unapproved shared results and derived summaries remain withheld under Q21.
5. **More:** try separate fictional player/spectator views, season invitations/revocation, private changeable ballots, explicit fictional cutoff controls, joint awards and exact-revision moderated illustrations. A real binary upload remains private when no scanner is configured. The native feasibility lab exposes deliberate notification/encryption probes.
6. **Connected service:** use `/` on the combined cloud review. Download current server data, make scoped edits or own-player replies, inspect accepted history and exercise controller claim, queued writes, exact retry, handover and retained conflicts. Production browser mode cannot open the private native controller cache; full synthetic controller rehearsal is explicitly labelled.

Each browser origin has independent IndexedDB data. Clearing/eviction/private browsing can lose it. A changed tunnel address does not migrate it. Browser reload or backgrounding cannot prove native clock continuity. Unsynchronised records and conflicting branches are retained rather than guessed or discarded.

## Local commands

```bash
cd /workspace/LongBall
bash scripts/setup.sh             # fresh workspace only
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

Open `http://127.0.0.1:4310` on that machine. A cloud workspace's localhost is not a desktop sharing link. The worker can run with `pnpm dev:worker` against the same database. `pnpm dev` starts Metro for a custom native development client; physical phones need a reachable Metro/API host. Expo Go cannot exercise SQLCipher.

A production entry export uses `EXPO_PUBLIC_ENVIRONMENT=production pnpm --filter mobile exec expo export --platform web --output-dir dist-production-review`. It requires connected sign-in, disables fictional accounts and opens no recording journal before sign-in. Identity issuer/client/redirects must be explicitly configured; secrets never belong in public Expo variables.

## Executed checks

Linux managed cloud, Node24.19.0, pnpm11.25.0, fictional data; no physical phone or signing identity connected. Final source/export identifiers are recorded with the shared review candidate.

| Check | Evidence and practical limit |
| --- | --- |
| Lint / TypeScript | Final root/mobile lint and TypeScript passed. ESLint reads the pinned mobile React version; generated exports are excluded. |
| Shared/domain/platform tests | Expanded suite: 219 passed in the final full checkpoint, including live events, planner, preparation, records, community, security, scope and journals. Additional integration regressions are recorded in the final checkpoint. |
| API / access / worker | 79 passed in the final full checkpoint: real Node HTTP/SQLite, scoped roles and idempotent replay, controller epochs, event audit, effective time, transactional rollback, concurrent migrations, backup/reopen, OIDC verification, activation-provider boundary, private media processing and worker retries. These do not prove production PostgreSQL or real provider/scanner operation. |
| Supplied pack / contracts | All15 archive members preserved,14 archived checksums passed, all6 fairness vectors inspected and full OpenAPI3.1 structural validation passed. The archived checker retains its historical `not_run` list; the wrapper separately executes the full validator. Companion event transport1.1 deliberately resolves C-001 without changing the archive. |
| Native JavaScript export | Android and iOS exports passed after expanded dependencies. These are JavaScript/Hermes bundles, not native compilation or installed-phone proof. |
| Browser feature journeys | Final export `f8f0a16481bae90ff4ebe5a3a137543c` passed all10 original match checks,6 live-event journeys and9 full application journeys, with no runtime errors. Production export `c343f02ba0ffe790b8bfdfe21c6c1995` passed all4 anonymous-entry checks. The same export passed all5 actual HTTP journeys, including in-flight offline suffix capture, exact retry, handover/quarantine, own-only views and workspace reopening. All reports are preserved in [the final checkpoint](evidence/2026-10-21/expanded/checkpoint.json). |
| Production anonymous entry | Four checks passed: connected sign-in required, no fictional identities/seed, no pre-login IndexedDB journal,390px layout without overflow/runtime errors. No configured identity is implied. |
| Cloud review | Runner verifies API health and public HTML before announcing ready. Independent public-browser evidence is recorded for each verified candidate; a running tunnel is not an uptime or storage guarantee. |
| Native compilation | Earlier managed-cloud Android attempt was blocked by policy refusal of the official React Native artifact host. Prepared independent public CI imports the exact checksummed development commit and compiles on a standard runner. Actual outcome must be recorded; a workflow file alone is not a pass. iOS compilation needs macOS/Xcode. |

Browser suites operate real controls and durable records, not injected domain states. Commands: `node scripts/browser-review.mjs`, `node scripts/live-review.mjs`, `node scripts/application-review.mjs`, `node scripts/connected-review.mjs` and `node scripts/production-entry-review.mjs`. They write reports/screenshots under ignored `.local/`. The first four expect the review export on4173; connected review starts its own isolated API databases. Production entry review expects the separately exported production build on4174. Chromium is required (`pnpm exec playwright install chromium`, or set `LONGBALL_CHROMIUM_PATH`). Accelerated browser time is not a physical50-minute match rehearsal.

## Remaining release gates

The [native proof register](implementation-scope.md#native-m0-proof-register) remains open: actual SQLCipher/wrong-key/key-loss/backup exclusions, sleep/lock/kill/reboot timing, full50-minute clock error bound, native offline recovery, Focus/battery/permission-denied notifications, photo picker/cache and outdoor/large-text/accessibility on both phone platforms.

The development SQLite API and worker do not establish production PostgreSQL migration/RLS/load/restore or hosted private object retention. OIDC verification and provider ports do not configure or prove a live identity provider, username-only required actions, household recovery or adult verification. Malware scanning fails closed until a maintained scanner/database is configured and validated. Authenticated binary delivery and metadata stripping are tested development behaviours, not approval for real child photos.

Q05–Q10,Q14–Q15,Q18,Q20 and Q21 remain in [decisions.md](decisions.md). No proposed+59-minute cutoff, recovery authority, injury retention, under-strength rule or U10 result audience is approved by a default or experiment. Some connected workflows remain intentionally unavailable pending those choices and trusted clock evidence; the feature register names other incomplete integrations. No production credentials, real child data, paid hosting, store enrolment or release publication was introduced.
