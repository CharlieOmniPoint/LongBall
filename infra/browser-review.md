# Browser review and deployment preparation

The browser surface is an Expo/React Native Web export of the native UI and shared domain/application packages. Development stays in cloud Codex. Native iPhone and Android remain the primary target; a browser result does not establish encrypted native recording, timing continuity or notification delivery.

## Temporary cloud review

The public repository's separate `preview/longball-m0` branch carries generated `site/`, bundled `backend/`, a checksummed development-source Git bundle and pinned workflows. A standard public GitHub Actions runner serves the combined Node API/browser application through a Cloudflare Quick Tunnel for up to five hours. This is an independent runner, not inbound access to managed Codex. It needs no Cloudflare account, custom domain or paid service. Main is unchanged; the runner imports and pushes the exact development commit from its verified source bundle.

The workflow is maintained in [cloud-preview/workflow.yml](cloud-preview/workflow.yml) and [run.sh](cloud-preview/run.sh). It installs a pinned decoder runtime, verifies cloudflared's SHA256, verifies API health, starts the worker and checks public HTML before recording a ready URL, source revision, Actions run and expiry in `preview-status.json`. Only an externally verified `ready` URL before expiry is a usable link. Cleanup records stopped/failed when possible. A separate lasting static GitHub Pages review is available below. Temporary API sessions carry no uptime or storage guarantee.

Review uses fictional Roma U10 data and explicitly enabled synthetic API identities. The default manager rehearsal uses IndexedDB; **More → Connected service** opens the distinct HTTP-backed workspace. Its data is persistent only for that runner's session. This separation prevents local rehearsal actions being silently treated as accepted server history. Review identity selectors are public fictional accounts, not authentication for real users. Sites is excluded because of its under-13 targeting restriction; no Site was created.

The review workflow uses a pinned source-built HEIC helper and a private ClamAV daemon for fictional media review. Its job budget is 360 minutes with a 300-minute (five-hour) ready-session lifetime. The earlier exact-source fictional session passed private scanned-PNG upload/review/publication at 13:24:37 UTC on 21 October. This does not establish ongoing signature-update operations or permanent media hosting; local PostgreSQL HEIC/restore evidence remains separate.

To renew from a clean committed development branch:

```bash
source scripts/dev-env.sh
python3 scripts/package-cloud-preview.py
```

The packager rebuilds from the clean committed tree and refuses changed source during packaging. Publish the generated payload through the connected GitHub tools to the preview branch using an expected-head update. Do not merge the generated tree into main. The package includes `site/build-info.json`, the exact source SHA and a verified bundle. The companion [native feasibility workflow](ci/README.md) compiles the same source on standard public runners. Binary artifact upload is disabled by default to avoid consuming account storage quota. No paid runner, store or production resource is provisioned.

A new tunnel hostname creates a new browser origin. IndexedDB records do not migrate; clearing, eviction and private browsing can lose them. Native production recording requires its protected journal. Production browser mode cannot open or persist the private native controller cache; online workspace views remain in memory. The full browser controller is restricted to fictional rehearsal.

## Lasting free fictional review

`infra/cloud-preview/pages-workflow.yml` prepares a static GitHub Pages review
alongside the temporary full API session. The owner enabled repository
**Settings → Pages → Build and deployment → Source → GitHub Actions** on
21 October 2026. The owner also added exact branch `preview/longball-m0` to the `github-pages` environment’s allowed deployment branches, retaining `main`. The connected repository tools do not expose those administration settings. The official
[configure-pages action](https://github.com/actions/configure-pages/blob/45bfe0192ca1faeb007ade9deae92b16b8254a0d/action.yml)
requires a different administration token to enable it automatically; no extra
token is requested or embedded here.

Package with `python3 scripts/package-cloud-preview.py --with-pages`.
This also builds Expo with the documented `experiments.baseUrl=/LongBall`, includes
only the generated fictional site in `pages-site`, and publishes through pinned
official Pages actions. The small required deployment artifact has one-day
retention. Public-repository Pages and standard public Actions are available on
GitHub Free; no paid capacity or custom domain is provisioned. The site remains
available after the temporary API runner stops. Each browser retains its own
fictional review state; connected API review still requires entering the live API session address. The temporary API explicitly permits the Pages origin; its expiry still applies.
It is not a deployed shared production database or a native-device proof.

The lasting address is [https://charlieomnipoint.github.io/LongBall/](https://charlieomnipoint.github.io/LongBall/). See [current review status](../docs/development/review.md) for the deployed source and the verified temporary API, now bounded to five hours. Historical source `c71f19dcea05f76adb0f7b5a4e2afb621d49bd40` deployed in [run39605988029](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39605988029). Public 390×844 browser checks at 13:14:27 UTC on 21 October verified that exact source, attendance → lineup → start → pause and static API-address guards without browser errors, failed responses or overflow.

The historical [renewed temporary API](https://circular-quizzes-trunk-pct.trycloudflare.com/) was ready at 14:20:04 UTC and expired at **15:20:04 UTC on 21 October 2026**. [Run39615563105](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39615563105) renewed transport metadata only: application source `c71f19d`, site and backend were unchanged. External build-info/health checks and a fresh 390×844 Pages connection passed at 14:24:39 UTC; [renewal proof](../docs/development/evidence/2026-10-21/feature-completion/cloud-review-renewal.json). That session used a fresh disposable fictional SQLite database; earlier records were not migrated.

The earlier `dennis-klein-initiatives-recipient.trycloudflare.com` session expired at 14:16:03 UTC. At 13:24:37 UTC, Pages privately uploaded and processed a generated PNG, required exact-image/rights review before publication, and verified its accepted team-logo pointer through an authoritative GET. [Original publication proof](../docs/development/evidence/2026-10-21/feature-completion/publication.json) remains unchanged historical evidence; the media journey was not repeated for renewal. Restricted PostgreSQL/HEIC/restore evidence remains a separate local rehearsal.

The published logo, first-time spectator activation, OS-authentication/device, HEIC and invitation-retirement increment passed 450 shared/platform tests, 219 API/access/worker tests, final exports and both native compilations. [Native proof](../docs/development/evidence/2026-10-21/feature-completion/native-ci.json) establishes compilation only. The separate [standalone Android artifact](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39608816471/artifacts/12350396424) built successfully and its downloaded ZIP/APK checksums and embedded bundle were independently verified; [proof](../docs/development/evidence/2026-10-21/feature-completion/android-device-kit.json). It requires arm64/API24+, uses a public debug test-signing key and expires at 13:39:45 UTC on 22 October. The [physical review guide](../docs/development/device-review.md) records the installation/test steps; no hardware execution is proved. The owner has a Windows PC and both phones but no Mac. The [unsigned iPhoneOS artifact](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39616024656/artifacts/12352708819) built successfully and its downloaded ZIP/IPA/checksums and actual device ARM64 metadata were verified; [proof](../docs/development/evidence/2026-10-21/feature-completion/ios-device-kit.json). It requires iOS16.4+, expires at 14:39:52 UTC on 22 October and uses the recorded local-notification-only override. The [Windows guide](../docs/development/iphone-windows-install.md) covers owner-local signing and seven-day renewal; those steps and physical installation/execution remain unproved. This candidate supplies no remote-push proof or production scope change.

The local subpath rehearsal is `node scripts/pages-review.mjs` against
`http://127.0.0.1:4176/LongBall/`, with the export mounted under that path. Set `LONGBALL_PAGES_REVIEW_URL` to the lasting address to exercise the same checks against deployment.

## Production deployment preparation

Use `EXPO_PUBLIC_ENVIRONMENT=production` for builds that enter verified connected sign-in and deny fictional identities. Do not embed secrets in Expo public variables. The configured OIDC provider must validate the real account lifecycle, authority and required actions; native credentials use SecureStore and browser credentials remain in memory. The private media pipeline refuses publication without configured scanning and exact-revision approval. Production controller caches are scoped to principal, API, team, season, match and account-specific device identity.

Before real users/data, settle the operating owner, budget, region, support/recovery authority, child-account/privacy/retention rules, result audiences and voting policy; then prove the production database/restore, identity integration, scanning operations and native device matrix. These gates are recorded in the feature and decision registers. Fictional review does not approve them.
