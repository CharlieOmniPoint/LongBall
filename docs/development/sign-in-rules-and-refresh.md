# Application sign-in rules and match refresh

25 October 2026 owner request: let Super Admin set application-wide username and password rules, make automatic match updates and their last refresh visible, and suggest team-based first usernames such as `Roma.SebL`.

## Account rules

**Super Admin → Clubs → Manage sign-in rules** edits one versioned policy across all clubs. Club Admin, Manager, Player and Spectator accounts cannot administer it. The API checks the current Super Admin grant and recent strong authentication; PostgreSQL runtime roles use narrow functions rather than raw policy-table access. Changes are audited and use optimistic revisions and an idempotency key. A lost save response retains the original update for explicit retry and holds ordinary navigation. Account locking and sign-out remain available.

Editable rules cover username minimum/maximum length, numbers and separators; password minimum length, upper/lowercase letters, numbers, symbols and exclusion of the username; and easily guessed Spectator PIN refusal. Username minimum is 3–32, maximum 8–40 and no shorter than the minimum. Password minimum is 8–64, with an input maximum of 128. Spectator PINs remain exactly four digits and cannot authorise another role. Initial defaults are 3–40-character usernames and 12-character passwords with the listed requirements enabled, plus simple PIN blocking. These defaults are editable demonstration behaviour, not acceptance of the deferred production identity/privacy decisions.

New usernames and newly chosen credentials use the current policy. Existing accounts keep their usernames and working credentials; neither this update nor a rule change silently renames the demo accounts or invalidates their passwords. Public policy metadata exposes no account directory or credential verifier.

The Keycloak adapter can apply the policy to the realm and enforce custom length/username checks during password setup/reset. Configured providers must acknowledge enforcement before a changed policy or new credential flow proceeds. Provider status is displayed explicitly. The connected demo has no password identity provider: its preauthorised account verifiers continue working, and newly registered Spectators use the saved rules directly. No production provider or paid service was provisioned.

Provider confirmation and the application database commit are separate systems. If the provider applies a revision and the database commit subsequently fails, the outcome needs reconciliation by retrying that exact policy update. The adapter rejects a lower revision or different rules at the same revision rather than silently rolling the provider back. Java unit tests and the adapter HTTP tests cover that contract; an actual realm setup/reset end-to-end check remains outstanding.

## First usernames

Where team and person names are available, initial usernames use team + first name + surname initial. `Roma U10` and `Seb Lawler` suggest `Roma.SebL`. Matching ignores letter case. A case-insensitive application namespace prevents two accounts in different teams or LongBall-managed credential flows claiming the same username. Child activation allocates a suffix atomically when necessary. Spectator registration lets the invitee review/edit its suggestion and reports an unavailable name without consuming the invitation; it does not expose a public username-availability search. Number-free or separator-free policies adapt the suggestion and suffix.

The optional Spectator name field stays on the device and is used only to compose the suggestion. It is not added to the registration payload. Existing accounts retain one identity when joining another team. Older provider invitation flows without a person's name retain a generated unique fallback rather than inventing a person's name or weakening the activation proof.

The namespace covers LongBall-managed demo, PIN and activation usernames. Existing external OIDC staff identities are stored by issuer/subject; their unseen external usernames are not imported. A collision with one of those names is safely refused by the identity provider and may require another name. Automatic suffix allocation does not claim to search an external provider's complete user directory. Staff access continues to use verified existing identities and administrative grants.

Core PostgreSQL migrations 026 and 027 add the policy and private username namespace. Existing activation/PIN names and configured demo names are reserved without renaming or silently merging conflicting identities. An existing conflicting database requires explicit reconciliation and is left intact. The expected core schema is now 27 with 47 row-secured tables; feature/media migration versions are unchanged.

## Match updates

Visible shared match views check every two minutes while idle and retain the existing three-second checks during active play. The Match Centre shows the time of the **last successful check** in UK local time, a refreshing indicator, and delayed-connection state. Checking for updates and the recorder's last synchronisation are separate facts. A failed request never advances the successful-check timestamp.

Manual refresh remains available. Hidden/background views stop polling; returning to the foreground requests an immediate check. Reads do not overlap, backoff is bounded, and scope/session changes discard late responses. Polling updates accepted shared views without replacing preparation drafts, match history pagination or the Manager's local match journal.

Physical iPhone/iPad/Android foreground/background timing and device password-provider flows remain device/provider acceptance work, alongside the owner's earlier deferred tests. Browser lifecycle tests do not establish OS background execution.
