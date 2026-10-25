# Club Admin persona review

The full browser journey passed **37 checks** on 25 October 2026, from **22:32:37.171 to 22:34:57.834 UTC**. The original sanitized report and two authenticated screenshots are copied without changing their content or timestamps.

`report.json` preserves the actual source state: HEAD `0961d1eb438ac2be591e71e6b3a92442aa72e38a`, with uncommitted product changes. This is candidate 4 evidence, not a claim that HEAD alone contains the tested work. The compiled client fingerprint is `fe455b35fee18875c51a314126191d536c6bab8b1ce02053cf614e1629d8b521`; server, worker, helper and scenario fingerprints remain in the report. The pinned artifacts were stable throughout the run.

The 390px screenshot shows the Club Admin team directory and distinct Open/Manage actions. The 1024px screenshot shows the tablet navigation and club report controls. The review asserted no horizontal document overflow at both widths. These captures contain generated team/account context and no passwords, session tokens, invitation capabilities or public demo credentials.

## What passed

- Every primary/More section in the authorised Roma team and season, plus club reports on phone and tablet.
- A real scoped Manager revocation, explicit review and restoration of the same verified adult, preserving the appointed-seat count.
- Creation of exactly one empty U12 nine-a-side team, opening its authorised scope and saving its configuration.
- Local creation/configuration draft guards, explicit discard and successful navigation afterward.
- A real origin team creation followed by an injected malformed200 receipt, an injected non-committing403 retry refusal, then the actual accepted same-key receipt. All three attempts use the same body/key; only one team is persisted.
- Directory search, age filters, clear controls and explicit entry to inherited Manager context, including the real eight-player Roma roster, formation designer and private selected-player core-position statistics.
- A second club granted by a separate Super Admin setup actor, followed by a normal fresh Club Admin login. Current-club selection, report search, age filters and club-switch resets remain scoped to the permitted clubs.
- Clicking the already-selected club preserves its loaded report. Real logout returns204 and closes all private Club Admin views.

## Findings corrected

| Finding | Observed problem | Result |
| --- | --- | --- |
| CA01 | Teams opened configuration forms instead of a directory. | Searchable authorised directory with explicit Open/Manage actions. |
| CA02 | Opaque adult account references were the primary staff assignment path. | Searchable candidate choices; reference entry is optional. |
| CA03 | A confirmed new team left its submitted name/create affordance in place. | Acknowledged form closes and offers direct Open/Manage actions. |
| CA04 | Inherited Admin management access was offered as a new appointed Manager; a full team rejected it as a fifth seat. | Existing inherited access is projected as current, without consuming appointed seats. |
| CA05 | A multi-club Admin initially saw the first alphabetical club rather than the current team club. | Initial selection follows the authorised current team. |
| CA06 | An age filter carried across clubs and hid the destination club's teams. | Report filters reset on scope changes. |
| CA07 | Generic duplicate adult labels made staff choices ambiguous. | Only duplicated labels receive a short, sufficiently unique authorised-reference suffix; final confirmation still shows the full reference. |
| CA08 | Clicking the current club cleared its loaded report without triggering another read. | Selecting the current club is a no-op, verified after the report has loaded. |

CA01–CA07 were observed on the pinned published f31 client. CA08 was observed in the first rebuilt candidate and corrected before this successful run. Earlier diagnostic attempts remain in `.local/quality/persona-club-admin-*-attempt-*`; they were not overwritten or relabelled. Two final diagnostic stops were scenario assumptions, rather than observed data loss: ordinary draft navigation uses an explicit guard message instead of a disabled tab, and the team form remains mounted across Clubs/Teams. The corrected scenario exercises actual protected clicks and visible form state.

## Boundaries

All service traffic reached owned loopback SQLite API/worker processes with generated local accounts. Browser discovery and virtual transport were redirected to those processes. This is functional browser evidence, not public-deployment, PostgreSQL, real email delivery, OS permission, native timing/audio/encrypted-storage or physical-device evidence. Other shared Manager journeys are reviewed by the Manager persona.

The five actual404 responses in `httpFailures` are intentional authority checks: global sign-in rules, global login analytics, global club creation, another club's report, and granting Super Admin access must remain unavailable to a Club Admin. The sole403 is an explicitly injected non-committing retry denial used to prove uncertainty retention; it is not an actual five-minute authentication-expiry test. There are no unexpected HTTP refusals, page errors or transport errors.

Q05/Q09/Q10 remain pending. Account data-request intake does not approve verification, support, retention, export fulfilment, deletion or access removal. No paid services were provisioned and no physical devices were tested by this review.

Reproduce after building matching demo web/API artifacts:

```sh
source scripts/dev-env.sh
LONGBALL_PERSONA_PHASE=final node scripts/persona-club-admin-review.mjs
```

`SHA256SUMS` authenticates the copied report, screenshots and this note. It does not alter the source fingerprints in the report.
