# LongBall

Native iPhone and Android team management, with a phone/tablet browser demo sharing the same interface and match rules. Development branch: `dev/longball-m0-journey`.

The demo includes Super Admin, Club Admin, Manager, Player/household and Spectator journeys; club/team administration, preparation, attendance, formations and lineup advice, manual match clocks, substitution alerts, goals/corrections, fair-time planning, reports, training, results, invitations, roster imports, FA records, private awards and moderated albums. Roma U10 contains the owner's eight selected demo players and four fixtures: two completed and two scheduled. Training remains separate. Initial user access stays free.

## Review

Open [LongBall](https://charlieomnipoint.github.io/LongBall/?review=97b6a49&verify=persona-final), refresh and sign in with your existing details. All twelve credential verifiers are unchanged; account details stay outside app screens and repository documentation. Published product: `97b6a49c7830da82a498a8dfb9108ad9b0cbfa69` on the development branch. PR1 remains draft and unmerged.

The five-persona pass simplifies Player/Spectator journeys and photo browsing, adds useful Account/Help/Privacy, protects staff drafts and same-account recovery, preserves custom formation geometry, improves scoped team/staff/report navigation, and fixes verified photo upload and recording for newly created demo games. Phone squad cards are 28% shorter with 44px controls; tablet cards use two columns. Sixteen rapid squad updates use 96 requests within the unchanged 120/min limit. Player position maps and the earlier full feature scope remain available.

[Persona evidence](docs/development/evidence/2026-10-25/persona-review/README.md) separates original failures, full role journeys and later targeted regressions. Local checks passed 1,008 shared/client tests,496 API tests plus 3 explicit absent-HEIC/HEVC-helper skips,45 real PostgreSQL migrations, full lint/types/contracts and the recorded role/browser suites. [Source-equivalent cloud CI](docs/development/evidence/2026-10-25/persona-review/ci-final.json) passed the functional/contracts/browser/image steps; overall CI failed only dependency enforcement. [Actual Android Debug and unsigned iOS Simulator compilation](docs/development/evidence/2026-10-25/persona-review/native-final.json) passed for the published source; installation, signing and physical-device acceptance remain separate.

[Public verification](docs/development/evidence/2026-10-25/persona-review/publication.json) confirms exact source/served JavaScript, API discovery/health/public policy, anonymous private-report denial and a 390px login screen. [Artifact comparison](docs/development/evidence/2026-10-25/persona-review/packaged-artifact-comparison.json) proves Pages differs from the tested browser only by its required 44-byte Expo path manifest entry, with identical tested API/worker bytes. Public checks used no credentials; authenticated journeys ran against isolated owned services.

The renewed free connected review runs until **04:09:15 GMT on 26 October 2026**. Pages persists; renewal resets disposable changes and ends old sessions. No paid service was provisioned.

[Two current high advisories in Expo CLI dependencies](docs/development/evidence/2026-10-25/persona-review/dependency-note.txt) keep dependency enforcement open; runtime/compiler lock audits separately passed. Real production identity/operations, signed distribution, physical-device acceptance and owner-deferred Q05/Q09/Q10 remain open. [Previous source-qualified releases](docs/development/review.md) retain their own test scopes.

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
