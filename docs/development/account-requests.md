# Account data and membership request journey

Account and security → **Review account data and membership requests** is available
to every authenticated account in native and browser builds. The service owns the
global account identity, complete membership list, confirmed request scope and
pending status. A shared household request is attributed to that account without
claiming which household member acted.

Global export and deletion explicitly cover all memberships, including recorded
expired or revoked access. Leaving a team is a separate request for one selected
current team and season. Removing a spectator access grant remains a different
access-management action. A fresh status read immediately before submission
prevents a stale membership confirmation from being silently reused.

The strict contract is defined in `packages/application/src/privacy-requests.ts`.
`GET /v1/privacy/requests` returns only this account's requests and full own
membership snapshots. `POST` requires either:

```json
{ "kind": "export", "scope": "all_memberships", "confirmAllMemberships": true }
```

```json
{
  "kind": "delete_account",
  "scope": "all_memberships",
  "confirmAllMemberships": true
}
```

```json
{
  "kind": "leave_team",
  "teamId": "selected-team",
  "seasonId": "selected-season",
  "confirmLeave": true
}
```

The client preserves an uncertain submission's exact body and idempotency key
only in memory. It never puts bearer credentials, account requests or a background
submission queue in the match journal. After a missing response it reads fresh
status first. Finding the canonical pending request resolves the uncertainty
without another POST; otherwise the user may explicitly confirm and retry the
original body/key. The backend also deduplicates the pending account/kind/scope
business request across new request keys and reloads. No response loss is treated
as proof that a submission failed.

Request histories preserve unknown legacy scope and original membership snapshots
as unknown, rather than substituting current memberships. Retained legacy
duplicates are labelled for service review. None of these states approves a
policy, authorises recovery, generates an export, revokes a membership, clears a
phone journal, deactivates an account or erases data.

Q05/Q09 verification, independent approval, lawful retention, export delivery,
controller handover, processor/backups and deletion fulfilment remain unresolved
release work. There is no claimed immediate erasure or invented retention period.
Before a live release the public web entry and configured authenticated service
must be operated at their agreed addresses; the static fictional review alone is
not an operational data-rights service.

Focused checks:

```sh
pnpm exec vitest run apps/mobile/src/platform/account-requests-core.test.ts \
  packages/application/src/privacy-requests.test.ts
pnpm --filter mobile typecheck
```

With the local Keycloak and restricted-role API trial from
`infra/identity/README.md` running, actual provider JWT coverage is available with:

```sh
LONGBALL_IDENTITY_TRIAL_API_PROOF=1 \
LONGBALL_IDENTITY_TRIAL_ACCOUNT_REQUESTS_PROOF=1 \
NODE_EXTRA_CA_CERTS=.local/identity/trial/ca.crt \
node --import tsx scripts/identity-trial-review.mjs
```

The harness deliberately drops a real committed privacy-request response, resolves
it through a fresh GET without reposting, checks a new-key business duplicate,
records separate global deletion and scoped leave requests, and verifies that
account status and memberships remain unchanged. The injected response loss is a
transport experiment; the provider JWT, API and PostgreSQL requests are real.
The actual phone-width browser trial passed six checks on 21 October 2026 against
the production entry, Chromium 155 and Keycloak 26.8.1. It entered the fictional
manager's credentials through the provider UI, enrolled TOTP and recovery codes,
returned through real PKCE and used API-verified identity. No session or vault
was injected. The isolated browser trusted only the generated local trial CA;
certificate validation stayed enabled. It checked explicit global confirmation,
fresh-status and renewed-confirmation retry with the original body/key, and a
lost committed leave response resolved without reposting. The 320px layout had
no horizontal overflow or application page errors. Sanitized evidence is in
`docs/development/evidence/2026-10-21/identity/account-requests-browser.json`.

To reproduce this isolated trial, serve the production web entry on
`http://localhost:4174`, register that exact callback/origin with
`scripts/identity-trial-support.mjs --enable-browser-review`, run the trial API
with `LONGBALL_IDENTITY_TRIAL_BROWSER_ORIGINS=http://localhost:4174`, then use:

```sh
bash scripts/build-identity-browser.sh
bash scripts/review-account-requests-ui.sh
```

The browser container mounts the repository read-only and hides its `.local`
directory, exposing only a generated fictional manager fixture, the public CA
certificate and its own evidence output. It installs that CA into an isolated
Chromium NSS database. Its host networking reaches the three loopback trial
ports; it does not change host trust or turn off TLS checks. Before another full
mutation proof, provide a fresh explicitly fictional manager/membership with no
existing pending leave request and use the guarded fictional-manager enrollment
helper. Existing pending requests are retained, never erased to reset a test.

Native navigation, system-browser return and physical-device behavior still
require device proof. These checks do not approve verification, fulfilment or a
production identity provider.
