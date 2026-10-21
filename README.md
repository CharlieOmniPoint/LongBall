# LongBall

Native iPhone and Android team management, with a phone-friendly browser demo sharing the same interface and match rules. Development branch: `dev/longball-m0-journey`.

The demo includes Manager, Administrator, Player/household and Spectator journeys; preparation, attendance, lineups, manual match clocks, goals/corrections, fair-time planning, reports, training, results, invitations, private awards and moderated albums. Roma U10 has a generated sample squad, opponents, fixtures and training sessions. Initial user access stays free.

Reports include queued CSV/PDF preparation with protected, explicit downloads and retained JSON export. The service uses the specified typed Fastify API, PostgreSQL and a separate worker. Accepted development source `6078969` includes readable reports and the verified database-locking correction. [The specification recheck](docs/development/specification-recheck.md) records source-bound verification and incomplete work; source coverage does not establish full release acceptance.

## Review

Open [LongBall](https://charlieomnipoint.github.io/LongBall/) and choose **Explore Roma U10 demo → a role → Open connected demo**. Use the [functional walkthrough](docs/development/functional-review-walkthrough.md) for the full journeys.

The Pages application and [demo API](https://spectrum-duty-bool-spouse.trycloudflare.com/) are externally verified at product source `6078969`, using Pages transport `11f627a` and runtime transport `ad3ee0b`. The Pages address lasts; its separate connected demo service runs for a bounded session ending **04:28:27 UTC on 22 October 2026**. All four connected role entries passed at 390px, with named sample context, distinct authorised navigation and no horizontal overflow or page errors. Protected PDF/CSV HTTP checks and an authorised player thumbnail passed; [review status](docs/development/review.md) records the managed-browser saved-file limitation. Connected changes are shared within that disposable session. Local rehearsal preserves that browser's existing saved work and does not silently upload or reset it. A fresh browser context loads the current sample season.

**Sign in** opens the real-account flow; current service assignments determine club/team/season access. Production entry omits demo identities. SEC20/SEC21 privacy fulfilment and the operator support/recovery console remain incomplete. The owner has deferred Q05/Q09/Q10 and physical phone testing. Operating identity/push/hosting, policy decisions and signed distribution remain release gates; this is a functionality-test environment.

For accepted source `6078969`, 742 shared/platform tests, 380 API tests without skips, 24 migration checks, lint/types/contracts, Node/source-publication checks and native/web/API JavaScript exports passed. Actual schema 16 HEIC and paired restore checks passed. The queued-PDF browser rerun passed with the real worker/download and readable Roma/Maple context. The unchanged local QL04 rehearsal passed narrowly: read p95 489.948ms, command p95 483.195ms; all earlier failures remain recorded. Two high build-tool advisories still fail the dependency quality gate. [Current CI](docs/development/evidence/2026-10-21/specification-recheck/quality/current-ci.json) passed 742 unit/377 API with three explicit HEIC skips/24 migrations/ten browser checks; its runtime-image job succeeded, and quality failed only at the dependency gate. The host 380-API/no-skip proof is separate. [Native compilation 39693154445](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39693154445) passed Android Debug and unsigned iOS Simulator builds. The workflow uploaded no binary, so there is no downloadable binary or artifact digest; signing, installation and physical testing remain unproved and deferred. See [review status](docs/development/review.md), [public verification](docs/development/evidence/2026-10-21/specification-recheck/source/publication-6078969.json) and [native provenance](docs/development/evidence/2026-10-21/specification-recheck/quality/native-compilation.json) for exact scopes.

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
