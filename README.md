# LongBall

Native iPhone and Android team management, with a phone-friendly browser demo sharing the same interface and match rules. Development branch: `dev/longball-m0-journey`.

The demo includes Manager, Administrator, Player/household and Spectator journeys; preparation, attendance, lineups, manual match clocks, goals/corrections, fair-time planning, reports, training, results, invitations, private awards and moderated albums. Roma U10 contains thirteen named sample players and four matches: two completed with consistent history and two upcoming with selection and availability replies. Training remains separate. Initial user access stays free.

## Review

Open [LongBall](https://charlieomnipoint.github.io/LongBall/?v=3e310d4) and choose **Sign in** with the existing supplied demo username and password/passcode. The service checks current membership before opening the assigned workspace. Account details remain outside app screens and repository documentation. The versioned link avoids older cached HTML. See [review status](docs/development/review.md) and [account setup](docs/development/demo-accounts.md).

Product `3e310d4` is externally verified on Pages and the [connected demo API](https://anti-direct-conjunction-eminem.trycloudflare.com/). All four public account journeys passed at both 320px and 390px, with successful sign-out, no page errors and no horizontal overflow. The Pages JavaScript matched the exact packaged bytes; the API confirmed thirteen profiles, four fixtures and two completed/two preparation matches. The connected session expires at **01:13:46 BST on 24 October 2026** (`00:13:46 UTC`). Pages persists; renewing its separate disposable API resets sample changes and ends prior sessions.

This update fixes sign-out during pending workspace activity, covers retained private views in the background and checks current access before revealing them again. Temporary failures offer retry; expiry or access denial closes the session. Both upcoming matches now use the saved squad, formation and player eligibility. A maintained browser check covers all four roles, lifecycle/recovery and real queued PDF/CSV downloads through a separate worker. Demo credentials are unchanged.

Host checks passed: **764 shared/platform tests, 396 API tests without skips, 24 migration checks**, lint, root/mobile TypeScript, contracts, publication/packaging, sample fixtures, six native configuration groups and both native Hermes exports. Eight clean-source demo phone journeys and ten ordinary matchday browser groups passed. Actual saved PDF and CSV files were parsed successfully. One earlier API run had a 30-second media-test timeout; the unchanged isolated case and later full suite passed. [Dated evidence](docs/development/evidence/2026-10-23/autonomous-checks/README.md) preserves that failure and its reruns.

[CI 40008906320](https://github.com/CharlieOmniPoint/LongBall/actions/runs/40008906320) verified a source-identical tree: 764 unit tests, 393 API passes plus three explicit decoder-dependent skips, 24 migrations, both browser journeys and the runtime-image job passed. Quality failed only at dependency enforcement. The compatible Expo tooling patch removes vulnerable uuid7; the registry withdrew the braces advisory. One unpatched high node-forge advisory remains, while runtime/compiler audits are clear. No gate was suppressed.

[Native build 40009330787](https://github.com/CharlieOmniPoint/LongBall/actions/runs/40009330787) passed both Android arm64 Debug and unsigned x86_64 iOS Simulator compilation. Upload is disabled, so no downloadable binary, signing, installation or physical-device pass is claimed. [The specification recheck](docs/development/specification-recheck.md) preserves the full agreed scope. Privacy fulfilment and the governed support/recovery console remain incomplete behind owner-deferred Q05/Q09/Q10; physical-phone tests, operating services, policy decisions and signed distribution remain pending. Production club OIDC is preserved. No paid services or real child data were introduced.

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
