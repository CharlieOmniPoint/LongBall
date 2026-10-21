# F05 activation implementation and remaining provider work

The SQLite development API now has an executable pending-child activation
service in `apps/api/src/activation.ts`. It requires an injected
`ActivationProvider` and an explicit `ActivationPolicy` containing a version,
positive expiry in milliseconds and `fictionalOnly:true`. There is no default
48-hour policy and no built-in provider, default administrator, child email,
password setter or credential database. The API configuration restricts this
experiment to the isolated synthetic-authentication environment. The command
line does not enable a provider automatically.

## Implemented boundary

An assigned, verified adult manager can reserve an account for an existing
active player profile in that team and season. The server generates an
immutable UUID and a random case-insensitive unique LB username independent
of name, age, shirt, team and season. A namespaced database trigger prevents
these child accounts changing classification. A pending account has only a
player membership and remains disabled while provisioning and activation are
incomplete. The provider must provision an idempotent, disabled, username-only
identity without requiring email or creating a credential. The service binds
the returned issuer/subject without adopting another account.

Provisioning reserves the local account and operation before the provider
call. Calls run outside SQLite transactions. Retry of the same request resumes
the same account and provider operation, including after process restart or an
uncertain provider response. Manager membership and account authority are
checked again before the provider binding is committed. A failed or revoked
operation retains its pending evidence; it does not enable sign-in.

Issuance generates 256 bits of random activation material, stores only SHA256,
and returns the plaintext once in the response body. It is never put in the
generic idempotency cache, audit, local URL or database. Retrying an already
issued request explains that the secret cannot be retrieved; an explicit
reissue with a new request ID revokes the previous token. If the household has
already begun a provider flow, reissue must cancel that operation first. The
provider cancellation contract must also prevent an in-flight begin call from
creating a late flow. Cancellation failure leaves the old token revoked and
the new issuance pending for retry. Concurrent issuance uses a persisted
generation so a superseded request cannot return an effective secret.

Household redemption claims a token once. The same redemption request can
retry its existing provider operation; a different request cannot reuse it.
Unknown, expired, used and revoked token states have the same public
unavailable response. The exact configured expiry boundary is enforced. The
service returns an expiring credential-setup URL only from the provider's
allowlisted HTTPS origins, in a non-cacheable response body. The raw LongBall
activation token cannot appear in that URL. Provider URLs and completion proofs
are not persisted or logged by this module. The household sets its credential
and receives recovery material in the provider UI; no manager password API is
available.

Completion requires the provider to verify its own opaque completion proof and
attest the exact issuer, subject and flow, credential setup, recovery-material
issuance and completion time. Only then can the pending child account become
active. Completion returns no app session or refresh token; full OIDC sign-in
is still required. A replay cannot re-enable an account disabled after
completion, grant an adult role, change classification or produce a second
completion audit record.

## HTTP integration contract

All write requests use `Content-Type: application/json`, the API contract header
and a stable `Idempotency-Key`; request IDs are passed to the service from that
header. Team scope is taken from the route and `seasonId` query parameter.
Manager routes use the existing authenticated principal and assigned-team
checks. Token and provider-proof routes are intentionally separate from app
sign-in and require the configured activation experiment.

| Route                                                        | Body                                                         | Result                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| `POST /v1/teams/:teamId/activation/pending-child?seasonId=…` | `{"playerId":"…"}`                                           | Pending UUID/username; no secret or session.    |
| `POST /v1/teams/:teamId/activation/issue?seasonId=…`         | `{"accountId":"…"}`                                          | One-time token body and explicit policy expiry. |
| `POST /v1/activation/redeem`                                 | `{"token":"…"}`                                              | Expiring provider setup URL and activation ID.  |
| `POST /v1/activation/complete`                               | `{"activationId":"…","completionProof":"…"}`                 | Completion status; full sign-in required.       |
| `POST /v1/accounts/link-requests`                            | Exact team, season, player and existing global account UUID. | Pending independent verification only.          |
| `POST /v1/accounts/recovery-requests`                        | Exact team, season and global account UUID.                  | Pending independent verification only.          |

Link and recovery requests deliberately do not look up or reveal whether a
global target exists, or expose its other memberships. Managers can request
these operations only within their own team scope. Names, approximate email,
shirt and display-label matching are not accepted. There is no automatic link,
credential reset, global membership transfer, proof approval or manager-led
recovery completion. Request rows retain policy version, actor, scope and exact
target for the future independently verified process. Neither a request nor
knowing an account UUID confers recovery authority.

## Provider and release decisions still open

`ActivationProvider` is a contract with a deterministic in-memory fixture in
tests. No real provider activation, email delivery, household verification,
recovery-code issuance or credential has been exercised. A generic Keycloak
Admin password-reset endpoint does not establish a safe username-only
household activation flow. This implementation does not label it as one.
Before writing a real adapter, verify the supported maintained provider flow
for disabled username-only provisioning, token-bound credential setup without
child email, cancellation/tombstones, independently verified completion and
once-only recovery material. If Keycloak requires a custom authenticator/action
token provider or SPI, review that explicitly rather than inventing an Admin
REST flow. A provider without these capabilities leaves activation unavailable.

The agreed verified household delivery process, Q05 verification owner/evidence,
Q09 data/lifecycle policy, Q10 operator/owner, global-account linking approval,
adult bootstrap/verification record and provider operations remain release
decisions. This code cannot approve them. Real children and live onboarding
remain blocked. No independent recovery verifier or approval route is
configured, so recovery requests cannot reset credentials or revoke another
team's account. The operational recovery procedure still needs verified-route
notification, session/device revocation and outstanding-event reconciliation.

Token-hash and failed-operation retention remains an explicit unresolved
lifecycle decision; no automatic deletion policy is silently selected. These
tables use a separate `lb_activation_schema` version and the development store's
transaction/backup mechanism. They do not change `PRAGMA user_version`. A
production PostgreSQL migration, external identity-database restore comparison,
rate/abuse controls at deployment and provider/household device tests remain
required. API responses must retain no-store/no-referrer handling and tokens,
provider URLs, proof bodies and credentials must stay out of access logs and
analytics.

## Verification

Run `pnpm exec vitest run --config apps/api/vitest.config.ts apps/api/src/activation.test.ts`.
The focused tests exercise configured-policy refusal, immutable classification,
cross-team and forged-authority denial, durable retry after uncertain provider
creation, hash-only storage, once-only secret retrieval, reissue and provider
cancellation failures, an in-flight cancellation race, token expiry/replay,
provider completion evidence, prevention of reactivating a disabled account,
exact-ID link/recovery capture and current-authority checks after an external
call. The provider fixture proves these service contracts; it is not proof that
a deployed identity provider supports them.
