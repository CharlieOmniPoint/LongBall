# Browser review and deployment preparation

The browser surface is an Expo/React Native Web export of the native UI and shared domain/application packages. Development stays in cloud Codex. Native iPhone and Android remain the primary target; a browser result does not establish encrypted native recording, timing continuity or notification delivery.

## Temporary cloud review

The public repository's separate `preview/longball-m0` branch carries generated `site/`, bundled `backend/`, a checksummed development-source Git bundle and pinned workflows. A standard public GitHub Actions runner serves the combined Node API/browser application through a Cloudflare Quick Tunnel for up to one hour. This is an independent runner, not inbound access to managed Codex. It needs no Cloudflare account, custom domain or paid service. Main is unchanged; the runner imports and pushes the exact development commit from its verified source bundle.

The workflow is maintained in [cloud-preview/workflow.yml](cloud-preview/workflow.yml) and [run.sh](cloud-preview/run.sh). It installs a pinned decoder runtime, verifies cloudflared's SHA256, verifies API health, starts the worker and checks public HTML before recording a ready URL, source revision, Actions run and expiry in `preview-status.json`. Only an externally verified `ready` URL before expiry is a usable link. Cleanup records stopped/failed when possible. A lasting review address and persistent hosted service remain open hosting tasks; temporary sessions carry no uptime or storage guarantee.

Review uses fictional Roma U10 data and explicitly enabled synthetic API identities. The default manager rehearsal uses IndexedDB; **More → Connected service** opens the distinct HTTP-backed workspace. Its data is persistent only for that runner's session. This separation prevents local rehearsal actions being silently treated as accepted server history. Review identity selectors are public fictional accounts, not authentication for real users. Sites is excluded because of its under-13 targeting restriction; no Site was created.

To renew from a clean committed development branch:

```bash
source scripts/dev-env.sh
python3 scripts/package-cloud-preview.py
```

The packager rebuilds from the clean committed tree and refuses changed source during packaging. Publish the generated payload through the connected GitHub tools to the preview branch using an expected-head update. Do not merge the generated tree into main. The package includes `site/build-info.json`, the exact source SHA and a verified bundle. The companion [native feasibility workflow](ci/README.md) compiles the same source on standard public runners. Binary artifact upload is disabled by default to avoid consuming account storage quota. No paid runner, store or production resource is provisioned.

A new tunnel hostname creates a new browser origin. IndexedDB records do not migrate; clearing, eviction and private browsing can lose them. Native production recording requires its protected journal. Production browser mode cannot open or persist the private native controller cache; online workspace views remain in memory. The full browser controller is restricted to fictional rehearsal.

## Later production deployment

Use `EXPO_PUBLIC_ENVIRONMENT=production` for builds that enter verified connected sign-in and deny fictional identities. Do not embed secrets in Expo public variables. The configured OIDC provider must validate the real account lifecycle, authority and required actions; native credentials use SecureStore and browser credentials remain in memory. The private media pipeline refuses publication without configured scanning and exact-revision approval. Production controller caches are scoped to principal, API, team, season, match and account-specific device identity.

Before real users/data, settle the operating owner, budget, region, support/recovery authority, child-account/privacy/retention rules, result audiences and voting policy; then prove the production database/restore, identity integration, scanning operations and native device matrix. These gates are recorded in the feature and decision registers. Fictional review does not approve them.
