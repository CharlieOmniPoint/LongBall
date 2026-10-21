# Fictional identity provider trial

Keycloak **26.8.1** is pinned for a local capability trial. This does not select
the production provider, approve real-child onboarding, choose activation expiry,
or resolve Q05 household linking/recovery authority. The extension uses Keycloak's
documented **internal** action-token, required-action and realm resource SPIs;
upgrading requires recompilation and rerunning the provider tests.

The public client uses code flow with PKCE S256. Direct password grants, implicit
flow, public registration, email login and provider password reset are disabled.
The fictional adult fixture requires TOTP. Application manager authority still
comes from its separate verified account classification and scoped memberships.
Provider roles do not become application authority.

## Run locally

Docker, Node 24.19.0, pnpm 11.25.0 and OpenSSL are required. The scripts use the
local Docker socket and preserve registry/proxy configuration. The Maven build
adds the managed environment's CA to a temporary Java trust store when supplied;
it never disables TLS verification. Container images are pinned by digest.

```sh
pnpm install --frozen-lockfile
bash scripts/build-identity-trial.sh
# Explicit fictional experiment inputs, not product policy defaults:
LONGBALL_TRIAL_ACTIVATION_TTL_MS=600000 \
LONGBALL_TRIAL_AMR_MAX_AGE_SECONDS=900 \
node scripts/start-identity-trial.mjs
```

The provider binds **127.0.0.1:8443** only. It uses its own H2 development database,
with private files under `.local/identity/trial`, outside the domain PostgreSQL
database. Startup creates a short-lived local CA/certificate, random temporary
bootstrap **service** credentials, random activation-service credentials, and a
fictional adult fixture credential. It prints no credentials. There is no default
admin password and no administrator password grant. Existing state and policy are
retained; the script refuses different policy inputs for the same trial directory.

Wait for the container to finish importing the realm, then:

```sh
NODE_EXTRA_CA_CERTS=.local/identity/trial/ca.crt \
node scripts/identity-trial-support.mjs
NODE_EXTRA_CA_CERTS=.local/identity/trial/ca.crt \
node --import tsx scripts/identity-trial-review.mjs
```

The support script removes email/name requirements from the isolated username-only
realm using the official user-profile Admin REST endpoint. The review harness
performs real Keycloak HTTPS protocol requests with normal CA verification. Its
Chromium instance only parses returned provider forms offline; it is **not** proof
of browser trust, native system-browser callbacks or device credential storage.
No password, OTP secret, recovery code, action token or completion proof is written
to evidence. A passing run writes a small `evidence.json` with explicit limits.

## Connect the real provider to the fictional API

The bounded PostgreSQL bootstrap reuses the runtime's restricted grants policy.
It creates exactly `longball_identity_trial` on the existing disposable loopback
test cluster, with dedicated non-superuser migrator/API/worker roles. It refuses
other databases. Existing state is preserved, never dropped or reset.

```sh
source .local/runtime/runtime.env
LONGBALL_IDENTITY_TRIAL_BOOTSTRAP=1 \
node --import tsx scripts/bootstrap-identity-trial-db.ts
source .local/identity/database/database.env
LONGBALL_IDENTITY_TRIAL_BOOTSTRAP=1 \
NODE_EXTRA_CA_CERTS=.local/identity/trial/ca.crt \
node --import tsx scripts/serve-identity-trial-api.mjs --bootstrap-fixture

# Separate serving process: no migration credential selector is accepted.
env -u LONGBALL_IDENTITY_TRIAL_MIGRATION_DATABASE_URL \
    -u LONGBALL_IDENTITY_TRIAL_MIGRATION_DATABASE_URL_FILE \
    LONGBALL_IDENTITY_TRIAL_BOOTSTRAP=1 \
    NODE_EXTRA_CA_CERTS=.local/identity/trial/ca.crt \
    node --import tsx scripts/serve-identity-trial-api.mjs --serve
```

The fixture bootstrap binds the actual provider subject only to a marked
fictional Roma manager and adds an unassigned fictional player. This explicit
offline fixture operation is not production adult verification. Serving accepts
signature-verified OIDC JWTs only; synthetic bearer aliases are rejected. The API
uses normal TLS on loopback `8444` and forwards locally to unpublished `4318`.
Runtime configuration excludes the provider bootstrap administrator and adult
fixture password. The serving DB role cannot run schema migrations.

With the API running, use:

```sh
LONGBALL_IDENTITY_TRIAL_API_PROOF=1 \
NODE_EXTRA_CA_CERTS=.local/identity/trial/ca.crt \
node --import tsx scripts/identity-trial-review.mjs
```

This explicitly resets **only the generated fictional manager's** test OTP and
recovery credentials, enrolls real provider TOTP, signs in afresh, and exercises
the actual manager → API → username-only household activation → separate child
sign-in journey. It checks child manager-denial and synthetic-alias refusal.
It never approves real household recovery or uses an authentication selector.

For a subsequent manual trial, explicitly prepare that same fictional manager
for your own authenticator enrollment:

```sh
NODE_EXTRA_CA_CERTS=.local/identity/trial/ca.crt \
node scripts/identity-trial-support.mjs --reenrol-fictional-manager
```

Read `.local/identity/trial/manager-fixture.json` privately in an editor for its
generated sign-in credential and exact client configuration. Do not share it.
The protocol harness discards its OTP secret and recovery codes; enroll your own
authenticator when reviewing interactively. This local trial requires a trusted
CA in the reviewing browser and exact registered redirect. The harness does not
prove those browser settings. Native testing needs a reachable trusted HTTPS
issuer/API and native return setting (`LONGBALL_IDENTITY_TRIAL_NATIVE_CALLBACK=1`),
which loopback addresses on this development host alone cannot provide.

## Provider activation boundary

`createKeycloakActivationProvider` is a server-only adapter. A dedicated service
account bearing `longball-activation-provisioner` can create a disabled,
username-only child with an immutable application UUID/subject binding. It cannot
adopt an existing provider identity. A manager never receives or sets a password.

The application issues its own random single-use capability, storing only its
hash. Redeeming it starts a signed provider action token with the explicit
application expiry and exact registered return URI. The provider enables the
pending user only for that guarded required-action flow; no credential exists at
that point. Password setup, recovery-code issuance and completion are separate
guarded required actions. Each checks the active operation, expiry and bound
authentication session while locking the target user. Cancellation records a
tombstone, including cancellation before a delayed begin request completes. An
already-open obsolete form cannot configure a credential after cancellation.

Completion requires actual provider password/recovery credentials and returns a
random proof in the registered callback **fragment**. Only its hash is retained in
provider user state. The LongBall API verifies it server-to-server before enabling
the application identity. Completion grants no session: full OIDC sign-in follows.

Once provider credential setup completed, the cancellation endpoint refuses to
reset it. If application completion or its callback is lost, the retained pending
state needs an independently verified reconciliation/recovery process. It must not
silently become a manager-led password reset. Q05 remains unresolved.

## App destinations

`longball://invite#teamId=…&seasonId=…&code=…` opens an invitation review after
sign-in; it never accepts it automatically. `longball://activate` opens capability
entry. `longball://activation/callback#longballActivation=<UUID>&completionProof=…`
opens explicit completion verification. OAuth's `longball://auth/callback` belongs
to AuthSession and is not interpreted as an invitation.

HTTPS links require exact owned origins in `EXPO_PUBLIC_LINK_ORIGINS` (comma
separated). No link can set issuer, API URL, client ID or role. Capabilities remain
in component memory, are removed from an accepted browser address fragment and
are never journaled. Reloading a browser loses the in-memory destination.

## Native/device proof still required

Use a configured HTTPS issuer/API reachable by the phone with a trusted
certificate. The isolated loopback CA is for the local trial; never disable phone
certificate validation. Register the exact app scheme and each platform callback.
On both iPhone and Android, test cold/warm invitation links, signed-out return,
cancelled provider browser, wrong state/nonce/activation return, interrupted setup,
expired/superseded activation, single-use replay, MFA enrollment and subsequent
fresh password+OTP login. Check provider logout/revocation, app expiry/lock,
SecureStore access after process death, backup/restore and device loss. Actual
password/recovery material must stay within provider UI and the household's own
storage. No physical-device result is inferred from builds or HTTP tests.

Official references checked 2026-10-21:

- https://www.keycloak.org/downloads (26.8.1)
- https://www.keycloak.org/server/containers
- https://www.keycloak.org/server/bootstrap-admin-recovery
- https://www.keycloak.org/docs/latest/server_development/index.html
- https://www.keycloak.org/docs-api/26.8.1/rest-api/index.html
- https://github.com/keycloak/keycloak/tree/26.8.1

## Recorded result and open release choices

On 2026-10-21 the pinned Maven/JDK21 extension compiled, and the real HTTPS
provider/API harness passed nine journey checks. The actual API used the separate
`longball_identity_trial_api` PostgreSQL role with runtime migrations disabled.
The PostgreSQL activation suite passed five tests, including initialization in an
actual read-only database transaction; provider transport fixtures passed four
tests and destination parsing passed ten. Native mobile TypeScript and scoped
ESLint passed. See the sanitized identity evidence in `docs/development/evidence`.

Still unproved: system-browser trust and popup handling, iOS/Android redirect
delivery, physical-device SecureStore/PIN/backup behavior, provider upgrade and
restore comparisons, operational monitoring, account recovery and a live pilot.
The official Firefox download hosts were unavailable under the workspace network
policy, so no isolated trusted-browser test was substituted or claimed.

Before live onboarding, choose and operate a production provider. Keeping this
Keycloak extension preserves the tested username-only path but requires owning
its internal-SPI compatibility, hosting, upgrades and recovery operations. An
alternative maintained OIDC provider must demonstrate the same disabled pending
identity, guarded cancellation and recovery-material capabilities through the
existing provider port; basic OIDC compatibility alone is insufficient. Neither
option is approved here, and no paid service was provisioned.

Q05 also requires a named independent verification authority and evidence rules
for linking/recovering an existing global household account. A club-designated
verified safeguarding/contact process and a centrally operated support process
have different staffing, audit and cross-club consistency costs; neither is
implemented as an automatic approval. Activation expiry and adult authentication
session policy likewise remain explicit experiment inputs, not adopted product
defaults.
