# LongBall development API

Runnable Node 24 HTTP API with a persistent local SQLite integration store. Native iPhone/Android remain the match-controller targets; this service supports shared TypeScript rules and browser rehearsal. No paid infrastructure is required. SQLite migration, backup and restore results are development evidence, not PostgreSQL production or physical-phone evidence.

From the repository root:

```bash
LONGBALL_SYNTHETIC_AUTH=1 node --import tsx apps/api/src/main.ts
node --import tsx apps/worker/src/main.ts --once
```

The API binds `127.0.0.1:4310`, persists `.local/api/longball.sqlite`, and accepts only loopback clients in explicit synthetic mode. Production mode refuses synthetic authentication. Without synthetic mode or a configured OIDC verifier, authenticated routes fail closed with `503 IDENTITY_NOT_CONFIGURED`. `/health` is a public, non-sensitive process check.

Fictional bearer labels include `synthetic-manager-1`, `synthetic-manager-2` through `-5`, `synthetic-admin`, `synthetic-account-player-01` through `-13`, `synthetic-spectator` and `synthetic-other-manager`. These labels are deliberately public demonstration selectors, not secure credentials. The first manager maps to `synthetic-account-manager` and has explicit administrator plus manager assignments; three other Roma managers fill the remaining places. A fifth cannot be assigned. Never use this mode for real accounts, children or photos.

Team: `synthetic-roma-u10`. Season: `synthetic-season-2026-27`. Match: `synthetic-roma-maple-2026-10-24`. GET `/v1/me` returns the verified principal and current memberships. Every command derives its actor from that principal; body role/classification values cannot create authority.

## Implemented routes

| Route | Boundary |
| --- | --- |
| GET `/v1/matches/:id` | Current membership; server constructs manager/own-player/spectator DTO. No teammate named records for children, no participation for spectators. Q21 sharing defaults to manager only. |
| GET `/v1/matches/:id/download?deviceId=...` | Assigned verified manager; roster, projection, versions and durable device sequence checkpoint. UTC observation is explicitly **not** a proven continuous clock mapping. |
| POST `/v1/matches/:id/controller` | Acquire one account/device-bound capability. A second controller requires handover or audited recovery. |
| POST `/v1/matches/:id/events` | Ordered batches, maximum 100 and 256 KiB. Atomic event/sequence/projection/idempotency write, permanent event-ID deduplication, reducer validation and retained rejected branches. |
| POST `/v1/matches/:id/handover` and `/handover/:transferId/accept` | Explicit offer, write freeze, receiving manager/device and incremented epoch. Preparation, already-paused play and half-time work. Running transfer fails with `CLOCK_ANCHOR_REQUIRED`; no invented pause/time mapping. |
| POST `/v1/matches/:id/recover` | Recent verified adult authentication, explicit unsynchronised-history risk confirmation and reason. Preserves old records and flags running-clock reconciliation. |
| GET `/v1/matches/:id/quarantine` | Managers inspect retained rejected events/conflicting submissions. No automatic merge/discard or reconciliation approval route. |
| POST `/v1/teams/:id/managers` | Current administrator, recent stronger authentication, verified adult target with stronger-authentication enrolment; transactional four-manager cap across team seasons. |
| GET/POST `/v1/teams/:id/preparation` | Manager preparation/typed commands; club edits additionally require administrator assignment. Optimistic revisions prevent stale edits. |
| GET/POST `/v1/teams/:id/preparation/own` | Own linked profile, fixtures/training and own response/attendance only. Typed own response/ranked-preference commands cannot select another player or change manager-owned fields. |
| GET/POST `/v1/teams/:id/community` | Server-bound role/current grant, typed commands and server receipt time. Responses use `getCommunityView`, never raw ballot/private state. Cached receipts cannot bypass current access. |
| GET `/v1/teams/:id/community/media/:photoId` | Re-check illustration gallery/own/review permission on every request. Pending items unavailable to ordinary viewers. |
| POST `/v1/teams/:id/media/uploads/prepare`, PUT `/media/uploads/:uploadId`, POST `/media/uploads/:uploadId/complete` | Real bounded JPEG/PNG byte upload with SHA-256, private quarantine, configured scanner and isolated decode. No scanner means completion fails closed; metadata-only receipts never publish an image. |
| GET `/v1/teams/:id/media/photos/:photoId/display` or `/thumbnail` | Authenticated private byte gateway; current grant, review state, revision, hiding/removal and Q21 policy rechecked each time. Originals have no delivery route. |
| GET/POST `/v1/teams/:id/records` | Role-filtered results/own participation; manager writes. Live archive uses the accepted server match. A manager cannot approve open Q21 through a command. |
| GET/POST `/v1/privacy/requests` | Own requests captured as `pending_verification_and_policy`; no erasure or approval of Q05/Q09 by inference. |
| POST `/v1/teams/:id/activation/pending-child` and `/activation/issue` | Assigned manager; optional isolated provider port, immutable child classification, disabled pending account and one-time hash-only activation secret. Not configured by the CLI. |
| POST `/v1/activation/redeem` and `/complete` | Bounded public capability/proof exchange; provider handles credentials/recovery material. Completion requires a fresh full OIDC sign-in and creates no session. |
| POST `/v1/accounts/link-requests` and `/recovery-requests` | Scoped manager requests retained for independent verification; no automatic account adoption, password reset or membership transfer. |

POST requires bearer authentication, JSON, stable `Idempotency-Key` and `X-Api-Contract-Version: longball.events/1.1`, except the public activation capability/proof exchange which still requires the contract and idempotency headers. Controller writes also require `X-Controller-Token` from acquisition. Store tokens securely, never in logs or public Expo configuration. Re-check current scope even for idempotent replay. Device sequences never reset across epochs; quarantined positions stay reserved.

Team receipt keys bind the season and selected role; replay under a different season cannot return an old private response. Spectator access is the union of current grants, intersected with SQL account/membership authority at every route. Revoking one invitation does not remove an independent valid grant, and revoking the last grant blocks match/results/media routes immediately.

`fixture.prepared` creates the canonical match from the shared immutable profile/formation snapshot. An existing claimed or recorded stream is never reset to accept a changed preparation snapshot.

Profile and training changes project current roster labels and season-filtered training evidence into records inside the same mutation transaction. Stable player IDs connect the documents; availability replies never mark attendance, cancelled sessions remain retained and are excluded from denominators, and saved match participation/configuration snapshots stay unchanged. Own-player training replies update only their response evidence. Selecting another live report/archive context remains an explicit manager `live.context.set` command; preparing a different fixture does not silently switch an active report match.

Connected `season.rolled_over` returns `503 SEASON_ASSIGNMENT_REQUIRED` without mutation. Explicit approved assignments, addressable new-season documents and spectator renewal must be supplied before enabling this command. The local fictional rehearsal supports the season workflow; the service does not silently copy authority.

Real media uses `X-Media-Upload-Token` for PUT/completion; its short-lived write token is hashed in the manifest and never cached as a plaintext generic idempotency response. Configure an absolute maintained `LONGBALL_CLAMSCAN_PATH` for scanning; the executable must identify itself as ClamAV and produce a clean scan result. No scanner/database has been installed or validated by the build. Completion derives and strips metadata in a separate bounded process, then links the stable community command and media manifest inside one SQLite transaction using fresh permissions/state. Pending bytes stay private; manager uploads still require explicit publication. JPEG/PNG are supported; HEIC remains unavailable until a tested decoder is selected. The private media directory must stay outside the browser export. A database-only backup does not back up media objects.

`contracts/events-v1.1.schema.json` is the deliberate C-001 companion. It requires immutable `engineVersion`; the archive stays unchanged. It adapts shared reducer commands and does not claim the original OpenAPI accepts an undeclared added field. Envelope effective time is the true event boundary, including late entries/correction targets; the replay checkpoint is separate. Unknown versions remain quarantined. The reducer validates typed transitions; this transport schema does not establish every original OpenAPI endpoint.

## Configured OIDC

Set trusted HTTPS `LONGBALL_OIDC_ISSUER`, `LONGBALL_OIDC_AUDIENCE` and `LONGBALL_OIDC_JWKS_URI`. The verifier checks RS256 signatures, cached RSA keys of at least 2048 bits, exact issuer/audience, expiry, not-before and subject. Unknown-key refresh is bounded. Strong authentication requires signed MFA/password+OTP evidence or an explicitly approved `LONGBALL_OIDC_MFA_ACR`; a bare hardware-key label is not assumed to prove user verification.

Signed claims do not assign application roles, promote children or establish adult eligibility. Issuer/subject mappings, account status, adult verification, stronger-authentication enrolment and memberships come from service records. Production bootstrap, household recovery approval and a real provider credential-setting adapter are not implemented. Operator/provider setup, exact redirects, username-only child activation, adult verification authority and tested provider recovery remain release gates. No identity provider is provisioned.

`createApi` accepts an optional `activationProvider` and explicit versioned `activationPolicy` only with synthetic authentication and `fictionalOnly:true`. There is no implicit expiry choice or CLI provider. The manager pending-child body is `{playerId}`, issue is `{accountId}`, with team path and season query; `Idempotency-Key` becomes the service request ID. Public redeem accepts `{token}` and complete `{activationId,completionProof}`. Link requests use `{teamId,seasonId,playerId,existingAccountId}`; recovery uses `{teamId,seasonId,accountId}`. Activation secrets are returned once, only hashes are retained, reissue revokes older tokens and cancels/tombstones provider flows, and plaintext secrets/provider links never enter the generic receipt cache. Responses use `no-store` and `no-referrer`. The provider port and test doubles establish the contract, not a live identity-provider implementation or approval of an expiry policy.

## One-origin browser export

```bash
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_API_PORT=4173 \
LONGBALL_STATIC_DIRECTORY=apps/mobile/dist-web \
node --import tsx apps/api/src/main.ts
```

Only permitted files inside the explicit export directory are served. Traversal, dotfiles and symlink escapes are refused. Only `/` resolves to `index.html`; unknown routes return 404. API authentication remains enforced. An explicitly configured reverse proxy may serve the fictional export/API; demonstration selectors still provide **no real-account security guarantee**. This server creates no tunnel, host or paid service.

## Persistence and limits

SQLite uses foreign keys, WAL and `BEGIN IMMEDIATE`. Documents are scoped by team/season/kind with revisions. This server store is **not** the encrypted native controller journal. Local permissions/backups do not establish production security or retention. The prepared PostgreSQL migration has not been executed or load-tested; production role/RLS grants intentionally remain uninstalled. Its device identifiers are canonical text with a 120-character limit, matching connected account-scoped device IDs and API validation; this source alignment is not PostgreSQL execution evidence.

Run `node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts`. Tests cover OIDC denial, team isolation, child promotion/fifth-manager denial, stale epochs, handover sequence continuity, retry deduplication, fault-injected atomic rollback, effective versus recording time, pending media/expiry/DTO privacy, privacy requests, actual SQLite backup/reopen and static path denial. Worker tests cover explicit cutoffs, tied awards, unchanged deadlines, late finalisation and retained bounded retries.

Physical-device evidence, real OIDC activation/recovery, running handover clock exchange, conflicting-history reconciliation, PostgreSQL migration/RLS/load/restore and live operating policies remain incomplete.
