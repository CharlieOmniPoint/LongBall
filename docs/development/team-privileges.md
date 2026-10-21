# Team contribution privileges · SEC17

Assigned managers can explicitly suspend or reinstate photo contributions and invitation creation for a current account in their team. Each decision requires a current team privilege revision, a stable request identity, confirmation and an operational reason code. An optional restricted note is retained with the immutable decision. A new request with a stale revision is refused; an exact accepted retry returns its original receipt without repeating or reversing a later decision.

The decision belongs to the **team**, across its seasons. Selecting another season, leaving and rejoining, or holding another role does not reset it. Membership and adult manager authority are verified independently. An administrator-only assignment, a player, a spectator or another team's manager cannot make these decisions by supplying a manager header.

Suspension holds new photo preparation, byte upload, completion, replacement and explicit self-publication. The service rechecks before linking a processed revision, including when suspension was accepted while scanning was in progress. The processed original and derivatives stay private and retained; reinstatement permits retry with the original upload identity when its existing expiry/status allows it. Current authenticated image reads retain their normal publication, account and revision checks. Already published images are not removed by a privilege decision.

Invitation suspension holds new issue and reissue. Existing pending invitations, accepted grants and explicit revocations retain their recorded state. Managers can still revoke invitations and review/remove content. Restoring a privilege does not restore a removed photo, reinstate a revoked grant or create a new invitation.

The target's status contains only current permission booleans. Manager list views contain scoped current account labels and statuses. Neither view exposes decision notes, reporter information or report details. No suspension notification is queued. This implements team contribution control; platform-wide safeguarding cases and operator account actions remain a separate boundary.

## Review journey

Connect as the fictional manager, choose **More → Upload and invitation privileges**, choose an account and review the desired action. Enter an operational code, review the team-wide effect, and confirm. The interface waits for the service receipt. The player's photo/invitation controls use a fresh, identity-bound own-status view; held in-memory upload capabilities remain available for explicit close and later authorised retry.

Real browser mutation bodies remain memory-only. Protected native outbox storage and explicit fictional browser review reuse the existing scope-bound outbox; no authentication, invitation or upload credentials enter this outbox. Replaying a retained privilege command requires fresh identity, membership and manager authority.

## Service and migrations

- `GET /v1/teams/{teamId}/privileges?seasonId=…`: current assigned manager's scoped account/status list and team privilege revision.
- `GET /v1/teams/{teamId}/privileges/own?seasonId=…`: authenticated current member's own booleans.
- `POST /v1/teams/{teamId}/privileges?seasonId=…`: `{command}` with `privilege.suspended` or `privilege.reinstated`, matching `Idempotency-Key`, `expectedRevision`, target account, `uploads`/`invitations`, reason code, optional restricted note and `confirm:true`.
- Existing canonical media, community photo and invitation writes enforce current privileges on the service boundary. PostgreSQL additionally restricts new invitation/media manifests and linking.

SQLite expansion **9** preserves existing documents, grants, events and receipts. PostgreSQL core migration **013** creates team-wide state and append-only decisions with current-manager row security and a narrow own-permission function. Media feature migration **4** adds current contribution checks and permits a current player's canonical processed-media completion to atomically link its private pending community revision. The API and worker remain non-owner roles; production schema application remains a separate migrator operation. Later feature migrations may advance these ledgers.

## Validation boundary

The focused tests exercise real HTTP requests against isolated fictional SQLite and restricted PostgreSQL, including role/scope denial, stale and exact duplicate decisions, audit/receipt rollback, explicit reinstatement, existing invitation/grant preservation, prepared upload tokens, cross-season persistence, other-team independence, suspension during scanning, private derivative denial and retained-key completion. Shared policy and outbox tests cover exact parsing and manager-bound protected replay. The scanner fixture accepts only the generated geometric test image and is not an antivirus claim.

Phone browser review evidence is produced by `node scripts/team-privileges-review.mjs` at 320 px and 390 px. This is fictional connected-browser evidence. Native device behaviour, real identity-provider operation, safeguarding response staffing and production policy acceptance require their separate checks; this increment provisions no paid services.
