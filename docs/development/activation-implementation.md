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

| Route                                                        | Body                                                                       | Result                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `POST /v1/teams/:teamId/activation/pending-child?seasonId=…` | `{"playerId":"…"}`                                                         | Pending UUID/username; no secret or session.    |
| `POST /v1/teams/:teamId/activation/issue?seasonId=…`         | `{"accountId":"…"}`                                                        | One-time token body and explicit policy expiry. |
| `POST /v1/activation/redeem`                                 | `{"token":"…"}`                                                            | Expiring provider setup URL and activation ID.  |
| `POST /v1/activation/complete`                               | `{"activationId":"…","token":"original capability","completionProof":"…"}` | Completion status; full sign-in required.       |
| `POST /v1/accounts/link-requests`                            | Exact team, season, player and existing global account UUID.               | Pending independent verification only.          |
| `POST /v1/accounts/recovery-requests`                        | Exact team, season and global account UUID.                                | Pending independent verification only.          |

Link and recovery requests deliberately do not look up or reveal whether a
global target exists, or expose its other memberships. Managers can request
these operations only within their own team scope. Names, approximate email,
shirt and display-label matching are not accepted. There is no automatic link,
credential reset, global membership transfer, proof approval or manager-led
recovery completion. Request rows retain policy version, actor, scope and exact
target for the future independently verified process. Neither a request nor
knowing an account UUID confers recovery authority.

Completion now requires the original opaque activation capability in the request
body together with the activation ID and independent provider completion proof.
The server checks the exact ID/token-hash pair before reading a provider flow or
calling the provider. Knowing a public activation UUID or provider return alone
cannot finish activation. The app keeps a redeemed capability only in component
memory while setup continues; after a cold start the household must paste the
original capability again. The original capability is never added to a callback
URL, phone journal, saved draft or provider setup URL.

If that original capability is lost after provider setup completes, the provider
return alone cannot activate the application account. The service cannot recover
the old plaintext token, and cancellation deliberately refuses an already
completed provider setup. This remains an independently verified Q05 recovery or
reconciliation case; a manager cannot bypass the token requirement or take over
the household credentials.

PostgreSQL activation feature version 2 installs and verifies row security after
core migration 005. Server-computed token hash/ID contexts narrow capability SQL;
only successful independent provider verification adds the final completion
marker before a new SQL transaction. Pending-child provisioning narrows manager
context with the generated account ID before opening each transaction. No SQL
transaction stays open across provider I/O. Runtime initialization verifies the
feature security state without running privileged migration DDL.

The earlier nine provider checks, four privacy API checks and six 320px browser
checks are retained as historical evidence for the first candidate. The later
completion protocol and row-security boundary passed a separate actual provider
rerun of ten checks, including missing/mismatched original capability refusal
and successful completion through the restricted PostgreSQL API. The bounded
migration compared hashes of original account, membership, match, document,
audit, privacy and activation columns and preserved every existing row. See
`evidence/2026-10-21/identity/keycloak-row-security.json` and
`evidence/2026-10-21/identity/row-security-migration.json`. This does not prove a
native device or approve live onboarding.

The four actual account-request API checks also passed after this migration,
including lost-response resolution, pending-request deduplication and retained
memberships/account status. Their separate result is
`evidence/2026-10-21/identity/account-requests-row-security-api.json`.

Worker-only migrations 006 and 007 were subsequently applied without changing
the original recorded columns or the API/identity authority. Runtime startup now
verifies core schema 007. A separate five-check smoke obtained fresh real manager
MFA/PKCE and child sessions, checked current identity and manager access, repeated
the capability-completion refusal/acceptance boundary, and refused child manager
access and fake authentication aliases. It skipped unrelated protocol
replay/cancellation/refresh cases. The initial ten-check provider and four-check
privacy evidence remains explicitly core 005. See `schema006-upgrade.json`,
`schema007-upgrade.json` and `keycloak-schema007-smoke.json` in the same evidence
directory. No physical-device result is inferred.

## Provider and release decisions still open

`ActivationProvider` now has a server-only Keycloak HTTP adapter and a pinned
Keycloak 26.8.1 fictional trial extension. Actual HTTPS tests exercised disabled
username-only provisioning, provider password and recovery-code setup,
cancellation of an already-open obsolete form after reissue, hashed provider
completion evidence, action-token replay refusal, separate child PKCE sign-in,
and adult TOTP with fresh password+OTP AMR. The combined trial also passed through
the actual PostgreSQL API with a restricted runtime role, verifying the child
classification and manager-denial boundary. This is not email delivery,
independent household verification, production-provider selection or phone proof.
See [the identity trial instructions](../../infra/identity/README.md).

Keycloak required a custom action-token/required-action extension; its official
SPIs are internal and may change without notice. The exact version is pinned and
requires ongoing compatibility testing. A generic Admin password-reset call is
not used as household activation. A provider without the guarded capabilities
leaves activation unavailable.

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
PostgreSQL implementation uses its own transactional feature migration and a
SELECT-only runtime verification mode; actual read-only transaction initialization
was tested. External identity-database restore comparison, deployment rate/abuse
controls and provider/household device tests remain required. API responses must retain no-store/no-referrer handling and tokens,
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
a deployed identity provider supports them. Separately, the actual PostgreSQL
suite passed five tests, the Keycloak transport fixtures passed four and the
service suite passed fourteen, including original-capability refusal before
provider I/O. Destination parsing passed ten. The real pinned provider/API
harness originally passed nine journey checks and passed ten after the
capability-completion and row-security change. The identity README gives the
exact reproduction commands and records which evidence remains missing.
