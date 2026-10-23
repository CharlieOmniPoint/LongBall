# Demo accounts and Roma U10 season

Current account-build source: `3e310d458bdc945a620db20728a3934d3d3c925d`. Use [the verified review entry](https://charlieomnipoint.github.io/LongBall/?v=3e310d4) and **Sign in** with the unchanged supplied credentials. [Review status](review.md) records current publication and API expiry. All four actual public roles passed sign-in/sign-out at both 320/390px. The clean-source maintained browser check also verifies session recovery and real saved PDF/CSV downloads. Native JavaScript exports, Android Debug and unsigned iOS Simulator compilation passed. Signing, distribution, installation and physical testing remain separate.

The demo login build opens with **Sign in → username and password/passcode → assigned team workspace**. Four preauthorised sample accounts cover Manager, Administrator, Player/household and Spectator. The service checks the credentials and current membership; the app derives the role from `/v1/me`. The account list and login details are supplied in the conversation, outside the app and repository documentation.

This profile replaces the public role chooser. Its API rejects the old static demo bearer tokens. Production builds keep their existing club OIDC sign-in, activation and permission checks; `EXPO_PUBLIC_DEMO_ACCOUNT_LOGIN=1` enables this separate journey only outside the production environment.

## Roma season

The sample season contains thirteen named players with shirt numbers, preferred positions, foot and goalkeeper choices, plus exactly four matches relative to the 22 October 2026 review:

| Date | Match | State and consistent records |
| --- | --- | --- |
| 10 October 2026 | Away to Oak FC | Completed, 2–2; half time 1–1. |
| 17 October 2026 | Home to Hill FC | Completed, 3–1; half time 1–1. |
| 24 October 2026 | Home to Maple FC | Scheduled, 10:00 kickoff; 09:30 arrival at Rovers Sports Ground. |
| 31 October 2026 | Away to Oak FC | Scheduled, 10:30 kickoff; 10:00 arrival at Oak Meadow. |

Both completed games are replayed through the normal match rules: seven pitch places, two manually ended 25-minute halves, nine attending selected players, goals, keeper coverage and substitutions. Their archived scores, attendance and participation derive from those same matches. Across the two games, all thirteen players have participation evidence. Historical albums and sealed awards use those played fixtures. Future matches have selection and availability responses; actual attendance, play and final results remain unrecorded. Training remains a separate schedule category.

## Runtime and packaging

The developer retains plaintext demo credentials only in an ignored local file, such as `.local/demo-accounts/credentials.json`, and communicates them directly to the reviewer. The separate `.local/demo-accounts/verifiers.json` contains a version, bounded session lifetime and account rows with only `username`, pre-existing `accountId`, base64url `salt` and a scrypt `hash`. Scrypt uses fixed `N=16384`, `r=8`, `p=1` and a 32-byte result. No plaintext credential field is accepted by the verifier packager.

From a clean, committed development branch, prepare the matching runtime and Pages exports with:

```bash
source scripts/dev-env.sh
python3 scripts/package-cloud-preview.py --with-pages --demo-accounts-file .local/demo-accounts/verifiers.json
```

The payload contains the verifier file and its SHA-256 digest as explicit runtime inputs, and enables the login flag in both browser exports. It does not package the ignored plaintext credentials. The native build request records the same nonsecret login flag. The cloud runner verifies the verifier digest, seeds approved sample media over loopback before creating a public tunnel, closes that bootstrap API and restarts the API with `LONGBALL_DEMO_ACCOUNTS_FILE` configured. Readiness requires `demoAccountLogin: true` and rejection of all four legacy role tokens before the tunnel is published. No paid secret-administration service is needed for this disposable demo.

Demo login requires explicit synthetic authentication, the demo scenario and a nonproduction process. An ordinary build without the verifier option retains its prior development configuration. The verifier-only packaging checks run with `python3 scripts/test-cloud-demo-packaging.py`; API login/session tests and mobile sign-in tests cover their separate boundaries.

## Session behavior and remaining gates

Successful login creates an opaque expiring token. The client holds it in memory, outside the saved match journal; the server retains its digest in memory. Refreshing the browser, restarting the client process or renewing the API requires another sign-in. Sign-out immediately closes the private workspace and requests revocation, including while another workspace or access check is pending. Normal navigation retains its unsaved-work guard. Backgrounding covers the mounted workspace without discarding in-memory drafts; foreground rechecks current account and role before revealing it. A temporary failure keeps it covered with Retry; denial or expiry returns to sign-in. Independent unsent match records remain retained. If the service cannot confirm revocation, the app reports that limitation. Existing recent-authentication rules still apply to sensitive administrator actions.

These accounts and populated records support functionality review. The [decision register](decisions.md) preserves the deferred privacy verification, retention and support-authority decisions; privacy fulfilment and the governed support/recovery console remain incomplete. Physical iPhone/Android tests, production providers/hosting/distribution and the recorded dependency-security gate also remain separate. Current deployment source, session expiry and observed checks belong in [review status](review.md), rather than being inferred from this setup guide.

## Repeatable browser acceptance

With the pinned workspace, Python requirements and Chromium installed:

```bash
source scripts/dev-env.sh
EXPO_PUBLIC_DEMO_ACCOUNT_LOGIN=1 pnpm --filter mobile exec expo export --platform web --output-dir dist-demo-web
pnpm build:api
pnpm test:demo:e2e
```

The runner creates a fresh private SQLite database, verifier file, encryption key and random preauthorised test credentials, then starts only owned loopback API/worker processes. It intercepts virtual discovery/API transport to those processes; it does not modify the public demo. It removes its temporary files/processes and replaces its own report directory on every run. Retained screenshots show signed-in workspaces only; passwords, opaque tokens and headers are redacted from diagnostics. The safe report and images are under `.local/quality/demo-account-review/`. GitHub CI runs this same check.
