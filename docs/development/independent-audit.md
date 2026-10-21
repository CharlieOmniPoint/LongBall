# Independent implementation and access review

21 October 2026. This is a bounded source/regression record, not a production security certification or physical M0 acceptance. Current scope and evidence are in [full-build-plan.md](full-build-plan.md). The root's intermediate unit run passed322 tests in35 files at09:34:51; the full actual-PostgreSQL API run is still running. Final staff/privacy/album UI integration and frozen-source acceptance remain pending. The earlier219/79 and `f8f0a164…` results are historical checkpoints.

## Reviewed boundaries and corrected findings

| Finding | Implemented correction and evidence |
| --- | --- |
| Mutation receipts omitted season/selected-role scope. | Canonical operations bind path/team/season/role; current authority is rechecked before cached receipts. HTTP cross-season negative regression. |
| Revocation and multiple spectator grants left stale authority. | Membership checks intersect the active grant union on every route; revoke/expiry and two-grant HTTP regressions. |
| Replacement managers had stale community identity shadows. | Community/media/report authority overlays current SQL accounts/memberships; replacement/revoked-manager HTTP checks. |
| Client registration could manufacture trusted finish/publication claims. | Service-owned registration only from accepted evidence; public mutation refused. Q21 remains manager-only by default. |
| New weak sessions could bypass retained PIN lockout. | Fresh verified stronger authentication required for locked credential adoption; old session IDs cannot unlock. |
| Network waits blocked local auth locking/sign-out. | Network work runs outside the serializer; generation guards discard late completions; local vault clears before bounded remote revoke. Actual-client deferred race tests. |
| Old workspace responses/export completions could cross auth/scope/expiry boundaries. | DTO attachment/render/export uses API/account/issuer/subject/team/season/role/player/generation guards. Access is checked again after awaited native summary and file write; files are removed on closure/share completion. Scoped denials invalidate parallel replies. |
| Canonical receipt/sequence uncertainty could permit a broken branch or block all later local play. | Exact immutable upload prefix/key, retained local suffix, fenced conflict handling and actor-bound accepted download; real HTTP response-loss/suffix/reopen checks. |
| Fractional keeper proof and validator accepted different sets; position mode could carry across fixtures. | Exact shared rational acceptance bounds and match-identity mode/settings guards; planner regressions. |
| Current preparation/training changes did not refresh reports. | Same-transaction stable-player evidence projection; RSVP/attendance distinction, cancellation, rollback and preserved archived snapshots verified over HTTP. |
| Late native check-in disappeared after kickoff. | Current-boundary arrival remains available until terminal and stays off pitch until a separate lineup change; conserved unavailable/bench/playing regression. |
| A successful clock exchange never reached event anchors. | Controller document now retains scoped mapping and newly queued envelopes reference its challenge; original pending bytes are preserved. New epoch/continuity drops active proof while retaining receipt history; actual client-to-HTTP finish evidence covered. |
| Fractional UTC rounding understated the stated uncertainty enclosure. | Rounded-center displacement is included in the propagated radius; fractional enclosure regression. |
| R01 staff and UI33 account request controls existed only as API seams/drafts. | Scoped staff helper/outbox and explicit own-account request helpers now support integration. Assignment uses current selected administrator/recent stronger authority and actual staff revision. Request scope/snapshot/dedupe never implies fulfilment. Final UI/HTTP acceptance pending. |
| Connected uploads silently selected the first match. | Explicit scoped game selection/albums are being integrated; final multi-game browser/HTTP acceptance pending. |

The clock audit independently exercised11 trusted-time/finish tests and3 exchange-client tests before the two new regressions. Current-controller/device/epoch/frozen checks, transactional single-use challenge consumption, accepted final-envelope actor/continuity binding, original award deadlines and eligibility/conflict downgrade were reviewed. Production entry explicitly refuses fictional clock-policy configuration. Existing trusted context/deadlines and sealed awards are never silently replaced by a later correction.

## Current independent service work

Connected season rollover validates recent stronger verified-adult administrator authority, the locked destination-year catalogue, explicit manager/admin/player assignments and retained player links. It enforces the four-manager limit, creates no spectator grant, and changes no source document/membership or old active match. Administrator-only configuration does not grant private child reports. Closing an old season is a separate undecided operation.

Records services allowlist historical fields, bind actor/time on the server, require scoped accepted match context and archive by exact accepted source revision. They refuse client training replacement and manager publication approval. Exports use already-permitted projections with audience/revision/policy metadata, formula-safe CSV labels and explicit unknowns. Players receive only own named participation; spectators receive no attendance/minutes. Accepted participation correction preserves original commands, clock and completion evidence; disputed-history application remains explicitly Q08-unapproved.

The actual notification repository passed14 tests across SQLite and PostgreSQL18.6;11 pure-rule tests also passed. Tests cover duplicate/conflicting keys, missing provider, current membership/grant/preferences/policy, London DST deferral, actual reopening/same-key retry, concurrent leases and transactions released before pending provider I/O. Non-idempotent uncertain outcomes are retained for review. Every provider is an explicit test double; no APNs/FCM receipt or device delivery is claimed.

New staff/privacy/outbox helpers passed26 scoped tests with clean root TypeScript and scoped ESLint. The staff DTO contains current scoped adult candidates, selected-season assignment status, other active season IDs and actual revision; disabled assignments continue occupying the authoritative cap until explicitly revoked. The request projector filters by authenticated account, preserves confirmed all-membership/team-season snapshots, retains unknown legacy scope and duplicate history, and exposes pending verification rather than deletion/fulfilment. Actual pending-key database/HTTP and UI checks are separate owner evidence.

## Runtime and identity evidence

The [real Keycloak trial](evidence/2026-10-21/identity/keycloak-trial.json) passed nine isolated HTTPS protocol/API checks, including actual adult TOTP, username-only household activation, separate child PKCE sign-in, restricted PostgreSQL API authority and child manager/synthetic-token denial. Chromium was an offline form parser; this is not system-browser callback, physical native storage, approved household verification or selected production-provider evidence. Earlier statements that no real provider had been exercised are superseded by this record.

The [actual runtime proof](evidence/2026-10-21/runtime/README.md) uses real PostgreSQL18.6/ClamAV, signed signature databases, bounded private image processing, transaction rollback and paired dump/restore/object hashes. Restricted container/API/worker/migrator evidence is recorded alongside it. This is not capacity, offsite recovery, signature-update SLA, live moderation operation or hosted deployment acceptance.

Android debug and unsigned iOS Simulator compiled for source `36223f7`; [native CI evidence](evidence/2026-10-21/expanded/native-ci.json) records zero retained artifacts and no app launch/physical proof. The [three rich connected browser journeys](evidence/2026-10-21/connected-rich/summary.json) and [extended canonical/history journeys](evidence/2026-10-21/history-review/README.md) exercise fictional HTTP/UI boundaries and real downloads, not native sharing or live children.

The root reports the intermediate `4108b235…` review export passed10 original,6 live,9 application,5 rich connected and5 canonical/history journeys; production `08278…` passed4 anonymous-entry checks. The newer staff/privacy/two-game-album UI still needs its fresh export and focused browser acceptance. Those earlier results must not be relabelled as acceptance of later code.

No full release acceptance follows from this bounded review. Remaining implementable UI composition and final checks are listed separately from Q05/Q09/Q10/Q21 decisions, provider credentials and physical proofs in the current feature register. No paid or hosted resources were provisioned for this review.
