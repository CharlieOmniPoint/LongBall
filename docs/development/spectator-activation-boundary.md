# Spectator invitation activation boundary

This implements SEC12/F22 using the existing canonical activation request and
response. It does not select a production provider, approve real onboarding,
choose a default invitation expiry or settle Q05 household recovery authority.

An authorized issuer requests a duration explicitly, or the service requires an
explicit configured policy. The service generates 32 CSPRNG bytes and returns
the raw invitation once in a fragment-only share URL at the configured public app
entry URL. A domain-separated SHA-256 verifier is retained. An exact issuance
retry returns a separately documented redacted 200 receipt requiring explicit
reissue; it cannot recover the old secret from idempotency storage. Plaintext
legacy pending invitations are retired and require reissue; accepted grant
history is retained.

The anonymous preflight reveals only invitation ID, expiry and policy version.
The canonical activation input is `{token,deviceId,policyVersion}`. Possession of
a current invitation can reserve one disabled, unclassified username-only account
and an immutable provider setup attempt. Neither membership nor adult authority
is created. Provider operations occur outside SQL transactions. Every database
boundary rechecks the exact invitation verifier and current season access.

The identity provider handles password and recovery material. Completion requires
the original invitation token, exact attempt UUID and an independently verified
provider completion proof. The account can become active only through the
post-verification database context. The user must then perform a separate PKCE
sign-in and explicitly accept the invitation before receiving its exact
team-season spectator grant. Existing account holders use sign-in and explicit
acceptance directly; this flow does not adopt accounts by name or fuzzy matches.

## Runtime metadata decision

The canonical `ActivationResponse` remains exactly
`{accountId,username,identityActionUrl,expiresAt}`. Its trusted provider action URL
temporarily carries one nonsecret fragment field `longballActivation=<UUID>`.
The client validates the configured HTTPS issuer origin, exact provider
`login-actions` path and sole UUID fragment, captures the attempt ID in memory,
then strips the fragment before opening the provider. The invitation secret is
never placed in a provider URL. The fragment is routing metadata only; original
capability plus attempt plus provider proof remain the authority.

The public share URL uses the configured static app entry, including its base
path, with `#longballInvite=1&teamId=…&seasonId=…&code=…`. Browser entry parsing
trusts only its exact own HTTPS page; native accepts explicitly configured
`EXPO_PUBLIC_LINK_ENTRY_URLS`. The exact localhost HTTP page is allowed only for
an explicitly fictional trial. Incoming links cannot configure an API, issuer,
client ID, role or trusted origin. Fragments are immediately removed from the
browser address and retained only in component memory. Custom-scheme routing is
a fallback; verified universal links still require deployment/device proof.

A trusted app-entry return tab may relay exactly the attempt UUID and provider
completion proof over a same-origin, app-path-scoped `BroadcastChannel`. The
original setup tab accepts only its retained, unexpired attempt and still requires
explicit service verification using its original capability. The capability is
never broadcast or placed in local storage. A cold return still asks for the
original capability. If the registered trial callback is on the provider origin,
the shipped explicit paste-return-link UI is the fallback; it validates the exact
attempt and trusted callback before the same service verification. Neither path
automatically accepts an invitation or grants a membership.

## Local proof

The pinned Keycloak 26.8.1 trial extension supports immutable `child_shared` and
`unclassified` pending identities. It never creates adult classification. Rebuild
with `bash scripts/build-identity-trial.sh` and restart only the owned fictional
trial container to load the new JAR. Apply core migrations using the dedicated
migrator, then serve using the restricted verify-only API role.

Run the existing real-provider harness with
`LONGBALL_IDENTITY_TRIAL_API_PROOF=1`,
`LONGBALL_IDENTITY_TRIAL_SCHEMA_SMOKE=1` and
`LONGBALL_IDENTITY_TRIAL_SPECTATOR_PROOF=1`, preserving normal local-CA TLS
verification. Its Chromium process parses provider forms offline; it does not
prove system-browser callbacks, trusted browser setup or physical devices.
Only sanitized evidence is shareable. Provider selection, real onboarding and
unapproved recovery/retention decisions remain open.

Adding `LONGBALL_IDENTITY_TRIAL_SPECTATOR_UI_PROOF=1` to that same run creates one
additional real PG-backed invitation using the already authenticated fictional
manager. It passes only the fresh invitation and public client configuration
through child stdin memory to the isolated trusted-CA browser image. The browser
opens the separately labelled local production-entry export on 4174 with
`EXPO_PUBLIC_FICTIONAL_IDENTITY_TRIAL=1`, types provider credentials in the actual
provider UI, uses the shipped return-link fallback, performs separate PKCE sign-in
and explicitly inspects/confirms/accepts the invitation. No browser vault or bearer
state is injected, and no extra adult MFA run is required for that child process.

For a focused repeat of the browser journey, add
`LONGBALL_IDENTITY_TRIAL_SPECTATOR_UI_ONLY=1` with the API, schema-smoke and
spectator flags. This still obtains a fresh strongly authenticated manager
session and issues a fresh invitation, then skips the already separate child
and spectator protocol checks. A failed run writes only bounded stage, response
status/code and control-count diagnostics, never raw provider URLs or proofs.

On 2026-10-21 the restricted schema-11 trial passed four actual provider/API
checks and six separate 320px trusted-browser checks against the labelled
`7efb97c8…` trial export. The browser used the shipped manual return-link
fallback, separate real PKCE, and explicit inspected acceptance. Normal CA
verification stayed enabled and no bearer/vault state was injected. See
[provider/API evidence](evidence/2026-10-21/identity/keycloak-spectator-activation.json)
and [browser evidence](evidence/2026-10-21/identity/spectator-activation-browser.json).
Automatic HTTPS return relay, settled post-acceptance workspace loading, native
system-browser callbacks and physical devices are separate unproved checks.
