# LongBall

Native iPhone and Android team management, with a phone-friendly browser demo sharing the same interface and match rules. Development branch: `dev/longball-m0-journey`.

The demo includes Manager, Administrator, Player/household and Spectator journeys; preparation, attendance, lineups, manual match clocks, goals/corrections, fair-time planning, reports, training, results, invitations, private awards and moderated albums. Roma U10 has thirteen named sample players and exactly four matches: two completed with detailed history and two upcoming with selection and availability replies. Training remains separate. Initial user access stays free.

Reports include queued CSV/PDF preparation with protected, explicit downloads and retained JSON export. The service uses the specified typed Fastify API, PostgreSQL and a separate worker. Current product source `214844e` adds preauthorised demo username/password accounts and the coherent four-match sample season while retaining readable reports and the database-locking correction. [The specification recheck](docs/development/specification-recheck.md) records source-bound verification and incomplete work; source coverage does not establish full release acceptance.

## Review

Open [LongBall](https://charlieomnipoint.github.io/LongBall/?v=214844e) and choose **Sign in → enter the supplied demo username and password/passcode**. Current service membership opens the assigned Manager, Administrator, Player/household or Spectator workspace. Account details are supplied in the conversation; the app shows no credential list or role chooser. See [demo account setup](docs/development/demo-accounts.md).

The [demo API](https://carroll-longest-leadership-ada.trycloudflare.com/) is externally verified at product source `214844e65310ccd4bb070b2f5a35395837fed19c`: health returned 200 with account login enabled, build information matched, and legacy role tokens returned 401. Runtime transport `5271088` is recorded separately. The bounded service session expires at **15:45:26 BST on 22 October 2026** (`14:45:26 UTC`). The Pages address lasts; its separate API session is temporary. Pages transport `d2bd607` deployed successfully and its actual JavaScript bytes matched the packaged export. All four actual public role logins and sign-outs passed at 390px without horizontal overflow or page errors. Use the versioned link above: the ordinary address initially returned cached `6078969` HTML despite updated build information. [Review status](docs/development/review.md) records that cache diagnostic and the verified entry.

The exact packaged Pages export passed all four role logins and sign-outs at 320/390px—eight entries—with no horizontal overflow or page errors. Wrong credentials were refused and password fields cleared; actual passcodes were absent from its final JavaScript bytes. The actual public build matched that artifact. The live API also confirmed thirteen profiles and exactly four matches: two completed and two in preparation. Season records show two played, one win, one draw, five goals for, three against and four app points. Connected changes remain shared within the disposable service session.

For source `214844e`, 756 shared/platform tests in 85 files, 394 API tests in 60 files without skips and 24 migration checks passed. Lint, root/mobile types, canonical/runtime contracts, source-publication validation, six verifier-packaging checks and sample-fixture validation passed. Both native Hermes exports passed with the demo-login flag, 1048 modules each; this is JavaScript export evidence. [Current CI 39757361652](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39757361652) passed 756 unit/391 API plus three explicit decoder-dependent skips/24 migrations/ten browser checks; quality failed solely at the dependency gate, and its source-equivalent runtime-image job succeeded. The separate host 394-API result has no skips. [Native compilation 39757554938](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39757554938) passed the actual Android arm64 Debug build with the demo-login flag; iOS is still compiling. APK existence was asserted, but upload was disabled, so no downloadable binary or artifact digest is claimed. Earlier source `6078969` image, restore, performance and native binary proofs remain historical and do not certify this account build.

The dependency gate remains failed: today's workspace audit records two high and one moderate findings; the separate API/runtime and compiler audits record none. SEC20/SEC21 privacy fulfilment and the operator support/recovery console remain incomplete behind owner-deferred Q05/Q09/Q10. Physical phone tests, operating identity/push/hosting, policy decisions and signed distribution remain separate release gates. Real club OIDC sign-in is preserved in production; no paid services or real child data were introduced.

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
