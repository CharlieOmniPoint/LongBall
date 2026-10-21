# LongBall

Native iPhone and Android team management, with a phone-friendly browser demo sharing the same interface and match rules. Development branch: `dev/longball-m0-journey`.

The demo includes Manager, Administrator, Player/household and Spectator journeys; preparation, attendance, lineups, manual match clocks, goals/corrections, fair-time planning, reports, training, results, invitations, private awards and moderated albums. Roma U10 has a generated sample squad, opponents, fixtures and training sessions. Initial user access stays free.

## Review

Open [LongBall](https://charlieomnipoint.github.io/LongBall/) and choose **Explore Roma U10 demo → a role → Open connected demo**. Use the [functional walkthrough](docs/development/functional-review-walkthrough.md) for the full journeys.

The Pages address lasts. Its separate connected demo service runs for a bounded five-hour session; [review status](docs/development/review.md) records the latest verified service and expiry. Connected changes are shared within that disposable session. Local rehearsal preserves that browser's existing saved work and does not silently upload or reset it. A fresh browser context loads the current sample season.

Real accounts use **Sign in** and receive only verified assigned club/team/season memberships. Production builds omit demo identities. Real identity/push/hosting, policy decisions, privacy-request fulfilment, signing/distribution and deferred physical-device acceptance remain separate release gates; this is a functionality-test environment.

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

The combined development server defaults to `http://127.0.0.1:4310` on the machine running it. A remote browser needs the published review address. Explicit demo mode is rejected in production. Actual uploads still require the configured scanner/decoder; sample image seeding uses that same private processing and publication pipeline.

`pnpm dev` starts Metro for a custom native development client. Expo Go cannot verify SQLCipher. The native code includes a sleep-inclusive clock, continuity checks, SQLCipher/SecureStore journal, local unlock and backup exclusions. Compilation does not establish installation, sleep/reboot timing, OS prompts, notifications, camera/picker/share, accessibility or physical encryption behaviour.

## Checks and evidence

`pnpm check` runs the application checks and builds. Configure a disposable PostgreSQL administrator URL for real PostgreSQL acceptance, then run `pnpm test:api`, `pnpm db:migrate:check`, and `pnpm test:access`; a skipped database suite is not PostgreSQL proof. Browser scripts use `LONGBALL_REVIEW_BASE_URL` and separate disposable APIs. `pnpm quality:inventory`, `pnpm quality:secrets` and `pnpm quality:dependencies` record dependency/licence, source-secret and registry-advisory results. An advisory failure remains a release finding, not a passed check.

- [Specification recheck and remaining work](docs/development/specification-recheck.md)
- [Review commands and actual evidence](docs/development/review.md)
- [Feature build plan](docs/development/full-build-plan.md), [traceability](docs/development/traceability.md) and [unresolved decisions](docs/development/decisions.md)
- [Native device guide](docs/development/device-review.md) and [native M0 register](docs/development/implementation-scope.md)
- [API and worker](apps/api/README.md), [media](docs/development/media-ingestion.md), [records](docs/development/records-implementation.md) and [database security](docs/development/database-security.md)
- [Preserved original pack](docs/longball/README.md), [canonical specification](docs/longball/LongBall_Mobile_Build_Pack_v0_1.md) and approved boards at the repository root
- [Browser hosting](infra/browser-review.md), [native CI](infra/ci/README.md) and [runtime setup](infra/runtime/README.md)

PostgreSQL uses separate migration/API/worker roles, current verified request context and row-level security. Runtime startup rejects owner, superuser, bypass and wrong-purpose credentials. Accepted recording history, controller conflicts, private ballots and pending media retain their authority boundaries. Privacy export/deletion requests can be captured and tracked; policy-approved fulfilment and deletion-ledger replay after restore still require implementation and operating decisions.

No paid services or real child data are introduced. Historical checkpoints and their exact test scopes remain under `docs/development/evidence`; they do not certify later source.
