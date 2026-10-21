# Reusable match plans

This implements the reusable match plans Should in [the canonical mobile specification](../longball/LongBall_Mobile_Build_Pack_v0_1.md). It is a private manager preparation feature for the current team and season. A saved formation alone is not a match plan: a template also retains reviewed starting allocations and proposed planner settings.

Open **Schedule → fixture → Save a reusable match plan from this fixture**. Save an explicit preparation snapshot, enter a name, allocate every formation place and review the settings. The save retains an immutable version of that proposal. On another scheduled future fixture, select the intended squad first, preview the template and explicitly confirm the copy. Changes to the plan, preparation revision or selected player eligibility require a fresh preview. The fixture can remove its copied proposal without deleting the template or earlier snapshots.

Copying never changes selected players, responses, actual attendance or accepted match events. The destination must be in the same team and season, have a compatible format and eligible players, and remain unplayed and unclaimed. The service checks accepted match state, event history and controller grants in its mutation transaction. A new season receives no old-season templates.

Preparing the destination freezes fresh profile snapshots alongside `initialLineupProposal` and `initialPolicyProposal`. These are review drafts. Actual check-in and normal lineup validation still precede explicit staging. Policy settings require the separate current-revision `policy.changed` confirmation; template versions, source authority and effective times are never reused as an active policy. Q07 remains unapproved, and minimum spell and batch settings remain soft preferences.

The existing revisioned preparation endpoint accepts `match_plan.saved`, `match_plan.applied` and `match_plan.cleared` commands. Existing role checks, command IDs, idempotency receipts and native encrypted outbox apply. Historical fixture snapshots are preserved. There is no new route, paid service or schema migration.

Validation evidence is in [reusable-match-plans](evidence/2026-10-21/reusable-match-plans/README.md). The actual PostgreSQL HTTP fixture uses the explicit operator-owned synthetic test mode; it does not establish a new restricted-role RLS proof. Native UI controls share the application helpers, but this increment has no physical-device acceptance evidence.
