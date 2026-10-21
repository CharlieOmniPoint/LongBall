# Invitation credential boundary

The connected service issues 32 CSPRNG bytes as a canonical 43-character base64url credential. Shared encoding checks validate representation; entropy comes from the service's `node:crypto.randomBytes(32)` call. Production lookup uses a domain-separated SHA-256 verifier. Fictional local review codes have a separate credential kind and never satisfy the connected verifier lookup.

The first create/reissue reply contains the share URL. Stored service receipts contain only redacted metadata. Exact replay returns HTTP 200 with `credentialAvailable: false` and `requiresReissue: true`; it does not replay the secret. Reissue is a separate action available to the original current player inviter or a current manager while the invitation remains unaccepted. It revokes the previous capability and cannot replace an accepted grant.

The in-memory client keeps an uncertain request's original key and bytes, bounds both fetch and response-body reads, and checks the current account/API/session/scope around every asynchronous exchange. It inspects the actual service destination before acceptance; URL team hints are not authority. Acceptance responses must match the inspected invitation and scope. Token-bearing inputs, requests and one-time URLs do not enter the generic workspace outbox or settled receipt history. Explicitly closing a pending request releases memory and does not undo a possibly completed remote operation.

Legacy retirement removes plaintext invitation fields and raw invitation command fingerprints, preserving command identities with domain-separated retirement fingerprints. Pending old credentials are revoked and require explicit reissue. Accepted grants, identities, unrelated memberships and earlier audit entries remain intact; a service retirement audit entry records the transition. Existing protected local candidates remain readable with their original bytes but cannot be replayed as connected invitations. No replacement candidate or identity is guessed.

## Checks

- Shared invitation/client/migration/community/outbox checks: **77 passed across 6 files**.
- Actual client → HTTP → SQLite checks: **3 selected tests passed across 2 files**; the other server tests were deliberately skipped in this focused run. The tests lose create and accept responses only after the service finishes, retry exact bytes/keys, reissue explicitly, retain a single grant, reject old generic invitation routes, and verify that database documents, invitation rows, audit and idempotency receipts contain neither the raw generated token nor the share URL.
- Root and mobile TypeScript, scoped ESLint, and `git diff --check`: passed on the integrated source snapshot.
- SQL migrations and provider activation have separate owner-run integration checks; this client proof does not establish a production provider or native-device activation result.

## Configuration still required

Issuance needs the explicitly configured application entry URL and invitation policy version. The client requires an explicit expiry of 1–48 hours; it introduces no default duration. Legacy retired credentials have no invented approved policy version. These changes do not approve competition sharing policy, account recovery policy or provider configuration.
