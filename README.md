# LongBall

Native iPhone and Android team management, with a phone-friendly browser demo sharing the same interface and match rules. Development branch: `dev/longball-m0-journey`.

The demo includes Manager, Administrator, Player/household and Spectator journeys; preparation, attendance, lineups, manual match clocks, goals/corrections, fair-time planning, reports, training, results, invitations, private awards and moderated albums. Roma U10 contains thirteen named sample players and four matches: two completed with consistent history and two upcoming with selection and availability replies. Training remains separate. Initial user access stays free.

## Review

Open [LongBall](https://charlieomnipoint.github.io/LongBall/?v=e2bf5a6) → **Sign in** with the unchanged supplied demo username and password/passcode. Account details remain outside app screens and repository documentation. See [review status](docs/development/review.md) and [account setup](docs/development/demo-accounts.md).

Published product `e2bf5a6` matches the actual Pages JavaScript and [connected API](https://nose-tale-office-holly.trycloudflare.com/). Public entry passed at 320/390px. The API expires at **04:35:29 BST on 24 October 2026** (`03:35:29 UTC`); Pages persists. Renewal resets disposable sample changes and ends old sessions.

This update retains manager fixture/training details, player filters and separate administrator drafts across saves; protects stale drafts with explicit review/discard; exposes archived saved selections for explicit future removal; and reopens recorded matches without replacing their saved preparation. Foreground access checking now verifies the exact selected team/season/role/player. Web accessibility selection states accompany the native states. Full native targets, agreed scope and visual direction remain preserved.

Checks passed: **784 shared/platform tests, 396 host API tests without skips, 24 migration checks**, lint/types/contracts/packaging, 6 native configuration groups and both Hermes exports. The clean-source demo browser passed 8 role journeys and 24 groups, with real PDF/CSV parsing, matchday uploads, spectator updates and access-revocation/conflict checks. 10 ordinary and 6 connected browser groups also passed. [Evidence](docs/development/evidence/2026-10-23/workflow-retention/README.md) preserves earlier failed attempts and corrected test expectations.

[Source-identical CI 40033876459](https://github.com/CharlieOmniPoint/LongBall/actions/runs/40033876459) passed functional/browser and actual production-image acceptance. Its API suite passed 393 with 3 explicit helper-dependent HEIC skips; the host suite above has no skips. Quality fails solely on the known unpatched high node-forge advisory. No gate was suppressed. Authenticated public-role repetition awaits explicit approval for the remote browser credential destination; direct workspace access is blocked by network policy. Local role checks and public anonymous/asset/API checks pass.

[Native 40034161097](https://github.com/CharlieOmniPoint/LongBall/actions/runs/40034161097) passed actual Android arm64 Debug and unsigned x86_64 iOS Simulator compilation. No binary upload, signing, installation or physical-device pass is claimed. SEC20/SEC21 privacy fulfilment and UI34 governed support/recovery remain incomplete behind owner-deferred Q05/Q09/Q10. Physical phones, production operating services/policies and signed distribution remain pending. Production club OIDC is preserved; no paid service or real child data was added.

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
