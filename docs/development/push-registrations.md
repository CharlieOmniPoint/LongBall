# Native team push registration (DS14)

This increment adds authenticated, account-bound push registration, rotation and withdrawal. It does not choose a production notification processor or prove notification delivery. Local match reminders and team notification preferences remain separate.

## Configuration

The API starts with registration disabled when both selectors are absent. To enable registration, mount private files and set:

- `LONGBALL_PUSH_PLATFORMS_FILE`: an allowlisted platform policy. Each configured `ios`/`android` entry contains `transport` and an operator-chosen `providerConfigId`. Treat that ID as an immutable processor/project binding; change it when changing the underlying project or processor credentials. Native APNs is iOS-only; native FCM is Android-only. Explicit Expo transport additionally requires its public `projectId` UUID.
- `LONGBALL_PUSH_KEYRING_FILE`: `{ "activeKeyId": "operator-key-id", "keys": { "operator-key-id": "<32 random bytes encoded as canonical base64url>" } }`.

Do not commit those files. There is no generated key, implicit processor, credential or project fallback. Partial or invalid configuration prevents API startup. The API's public status exposes only configured platform metadata, never key material.

A selected deployment injects a `RegisteredPushSender` into `createRegisteredPushProvider`. No sender is bundled or provisioned here. The adapter resolves encrypted destinations only for the current leased notification recipient, then calls the selected sender outside database authority. A sender must implement truthful provider receipt/uncertain-outcome semantics; existing quiet hours, preferences, current membership and entity-access checks still run. Registration configuration alone leaves `deliveryConfigured` false. That flag may be enabled only alongside an actual configured sender.

## HTTP boundary

All endpoints require the existing verified identity and active account. They work for every account role, including an account with no team membership. Device identifiers are metadata and confer no authentication.

| Endpoint                                      | Behavior                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me/push-registrations`               | Own-account status, allowed platform configuration and per-device metadata. No token, token hash or ciphertext.                                                                                            |
| `POST /v1/me/push-registrations`              | Canonical `{deviceId,platform,transport,token,appBuild,permission}`; accepts only the same account/issuer's current enrolled native platform and configured transport. Returns `{id,revision,serverTime}`. |
| `DELETE /v1/me/push-registrations/{deviceId}` | Withdraws this account's registration, clears encrypted token material and retains a revision tombstone. Returns HTTP202 `{operationId,status:"completed",serverTime}`.                                    |

Mutations use existing `Idempotency-Key` and `X-API-Contract-Version: longball.events/1.1`. This runtime additionally requires quoted `If-Match: "<revision>"`, using the GET device revision or `"0"` when absent. Missing revision returns428; stale revision returns409. Both the JSON body and revision are included in the stored request signature hash. Exact retry returns only the original metadata receipt and rechecks current account/enrollment/configuration. A retained old receipt never reactivates a revoked destination. Reuse of a key with different bytes or revision is rejected.

The GET status and generation header are runtime extensions; the supplied canonical contract remains unchanged. The tombstone prevents delayed initial registration from overtaking withdrawal. Changing the token, permission, processor binding, app build or active encryption key advances the revision atomically. Identical current-key registrations are a no-op.

## Persistence and security

PostgreSQL core014 and fictional-development SQLite10 are additive after SEC17 core013/SQLite9. Neither migrates existing devices into push opt-in. PostgreSQL serving roles cannot run migrations. RLS, triggers and grants bind writes to current active account, issuer, enrolled device/platform and operation; a worker has no broad token table read. Its protected resolver requires the exact live notification lease and original recipient.

Tokens use randomized AES-256-GCM. Additional authenticated data binds issuer, account, device, transport and provider configuration. Retain previous decryption keys during rotation; new writes use the active key, and a native renewal re-encrypts old-key material. Missing/wrong keys or modified bindings fail closed. Withdrawals remain available when registration configuration is disabled. Unknown-key ciphertext is retained rather than replaced with a generated key. Key retirement requires preserving backups and verifying all required live rows have renewed; this increment does not schedule an operator rotation job.

Only encrypted token material and a domain-separated digest enter the token table. Generic HTTP receipts retain metadata and request-signature hashes. Audit records contain action/device/outcome only. The raw token is absent from application tables, generic journals/outboxes, notification payloads and retained logs. Sender destinations exist only in private server memory.

## Native account experience

Account → Team notifications on this phone offers explicit Enable, Stop and protected Retry. Enabling enrolls the current app device, reads the approved policy, then asks OS permission and obtains the matching native token. Existing local-reminder permission never opts an account into remote updates. Android creates its notification channel before permission/token requests. iOS provisional permission is recorded honestly.

Foreground checks and native token-rotation callbacks renew an existing registration without another opt-in prompt. Observed permission withdrawal removes it on the next app foreground check; an offline phone cannot promise immediate server withdrawal. Exact pending requests are saved before sending in account/issuer/device/API-scoped, device-only OS-protected chunks; a manifest commits last. An uncertain OS manifest write is read back before any cleanup. Locked/unreadable evidence is retained. Process-loss retries keep the same request ID, body and expected revision. Newer server generations can safely fence a stale request. Session changes stop token capture and state adoption.

Stop is separate from local sign-out. Local sign-out does not promise a remote withdrawal, particularly when offline; use Stop and confirm its server status before leaving if withdrawal is wanted. Generic remote messages remain free of child names, scores or other private content. Existing device inventory deliberately offers no remote device revocation policy.

Browser review cannot obtain, persist or submit phone tokens. The native SDK wrapper is selected only on iOS/Android. No manual token entry is exposed.

## Verification and remaining proof

Focused tests cover actual SQLite and restricted-role PostgreSQL HTTP calls, raw-token absence across the application database, stale/rotated/revoked registrations, cross-account refusal, current enrollment changes, disabled accounts, exact metadata retries, protected worker resolution, key rotation/AAD isolation and migration preservation/rollback. Pure native adapter tests exercise OS permission/session races, process-loss retry and uncertain protected writes. These use fictional tokens and injected sender ports.

Physical notification permissions, token rotation, SecureStore/process termination, APNs/FCM/Expo credentials and real delivery remain unproved. No paid service, provider account or notification credential was provisioned. Current registration configuration and provider availability must be assessed independently from the app's existing local warning and notification preference journeys.
