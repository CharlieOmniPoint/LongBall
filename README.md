# LongBall

Native iPhone and Android team management, with a phone/tablet browser demo sharing the same interface and match rules. Development branch: `dev/longball-m0-journey`.

The demo includes Super Admin, Club Admin, Manager, Player/household and Spectator journeys; club/team administration, preparation, attendance, formations and lineup advice, manual match clocks, substitution alerts, goals/corrections, fair-time planning, reports, training, results, invitations, roster imports, FA records, private awards and moderated albums. Roma U10 contains the owner's eight selected demo players and four fixtures: two completed and two scheduled. Training remains separate. Initial user access stays free.

## Review

Open [LongBall](https://charlieomnipoint.github.io/LongBall/?review=d07cf42) → **Sign in** with the unchanged supplied username and password/passcode. Account details remain outside app screens and repository documentation. See [current review status](docs/development/review.md) and [account setup](docs/development/demo-accounts.md).

Published product `d07cf42ae04b17ff6c00f1d84f2e5c8bed2a9114` adds **Super Admin → Clubs → Login activity**. The purple dashboard includes active accounts, sign-in trends, club/team and account-type breakdowns, and filterable event history. It checks every minute in the foreground, displays its last successful UK-time update and pauses automatic refresh while older event pages are open. Active means authenticated API use within 15 minutes; earlier login history is not invented. [Reporting definitions and limits](docs/development/login-activity.md).

Super Admin sign-in rules, editable team-based username suggestions such as `Roma.SebL`, and visible automatic match-refresh status remain available. The [public deployment proof](docs/development/evidence/2026-10-25/login-activity/publication.json) verifies the served source/JavaScript, current API discovery and health without transmitting account credentials. The connected free review service runs until **20:24:56 GMT on 25 October 2026**; Pages persists. Renewal resets disposable changes and ends old sessions.

[Current evidence](docs/development/evidence/2026-10-25/login-activity/README.md): 955 shared/client tests, 495 API passes plus three explicit absent-HEIC-helper skips, 45 actual PostgreSQL migration checks, nine dashboard browser groups, and eight existing role/width journeys with 28 checks passed. Lint, TypeScript, preserved contracts, packaging and source secret checks passed. [Actual Android Debug and unsigned iOS Simulator compilations](docs/development/evidence/2026-10-25/login-activity/native-final.json) also passed for this source. [Source-equivalent cloud CI](docs/development/evidence/2026-10-25/login-activity/ci-final.json) passed substantive functional/browser and production-image checks, but overall CI failed dependency enforcement (workspace audit failed or unavailable). Compilation does not establish physical-device acceptance.

The unwaived workspace dependency-security gate, real production identity/operating services, signed distribution, physical-device acceptance and owner-deferred Q05/Q09/Q10 privacy/support decisions remain open. No paid service was provisioned. Keep PR 1 draft and unmerged.

## Run locally

Use Node **24.19.0** and pnpm **11.25.0**:

```bash
bash scripts/setup.sh
source scripts/dev-env.sh
pnpm install --frozen-lockfile
pnpm test:unit
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_DEMO_SCENARIO=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

The combined development server defaults to `http://127.0.0.1:4310` on the machine running it. These commands use the ordinary development review configuration. The [credential-login profile](docs/development/demo-accounts.md) uses explicit verifier packaging and pinned published-service discovery. A remote browser needs the published review address. Explicit demo mode is rejected in production. Actual uploads still require the configured scanner/decoder; sample image seeding uses that same private processing and publication pipeline.

Queued CSV/PDF exports also require the separate worker, using the same database, configured export key file and TTL as the API. The API-only command above does not process queued exports; use the [protected-report guide](docs/development/report-exports.md) and [runtime setup](infra/runtime/README.md).

`pnpm dev` starts Metro for a custom native development client. Expo Go cannot verify SQLCipher. The native code includes a sleep-inclusive clock, continuity checks, SQLCipher/SecureStore journal, local unlock and backup exclusions. Compilation does not establish installation, sleep/reboot timing, OS prompts, notifications, camera/picker/share, accessibility or physical encryption behaviour.

## Checks and evidence

`pnpm check` runs the application checks and builds. Configure a disposable PostgreSQL administrator URL for real PostgreSQL acceptance, then run `pnpm test:api`, `pnpm db:migrate:check`, and `pnpm test:access`; a skipped database suite is not PostgreSQL proof. Browser scripts use `LONGBALL_REVIEW_BASE_URL` and separate disposable APIs. `pnpm quality:inventory`, `pnpm quality:secrets` and `pnpm quality:dependencies` record dependency/licence, source-secret and registry-advisory results. An advisory failure remains a release finding, not a passed check.

- [Specification recheck and remaining work](docs/development/specification-recheck.md)
- [Review commands and actual evidence](docs/development/review.md)
- [Feature build plan](docs/development/full-build-plan.md), [traceability](docs/development/traceability.md) and [unresolved decisions](docs/development/decisions.md)
- [Native device guide](docs/development/device-review.md) and [native M0 register](docs/development/implementation-scope.md)
- [API and worker](apps/api/README.md), [media](docs/development/media-ingestion.md), [records](docs/development/records-implementation.md) and [database security](docs/development/database-security.md)
- [Protected CSV/PDF exports](docs/development/report-exports.md) and [Fastify transport](docs/development/fastify-transport.md)
- [Preserved original pack](docs/longball/README.md), [canonical specification](docs/longball/LongBall_Mobile_Build_Pack_v0_1.md) and approved boards at the repository root
- [Browser hosting](infra/browser-review.md), [native CI](infra/ci/README.md) and [runtime setup](infra/runtime/README.md)

PostgreSQL uses separate migration/API/worker roles, current verified request context and row-level security. Runtime startup rejects owner, superuser, bypass and wrong-purpose credentials. Accepted recording history, controller conflicts, private ballots and pending media retain their authority boundaries. Privacy export/deletion requests can be captured and tracked; policy-approved fulfilment and deletion-ledger replay after restore still require implementation and operating decisions.

No paid services or real child data are introduced. Historical checkpoints and their exact test scopes remain under `docs/development/evidence`; they do not certify later source.
