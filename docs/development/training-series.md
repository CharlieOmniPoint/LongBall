# Recurring training

Managers can create a weekly training series from Schedule → Training. The form requires an explicit occurrence count (2–52), previews every calendar date, time, venue and expected player list, and saves only after confirmation. All occurrences must fit in the current season. The weekly builder performs calendar arithmetic; it does not invent UTC offsets or resolve ambiguous local times.

Every occurrence has its own stable identity and shares a recurrence group. **Edit this occurrence** can move or edit one scheduled date. **Edit or cancel scheduled series occurrences** previews the exact scheduled list and changes its common time, venue or expected players, or explicitly cancels that list. Bulk changes keep each occurrence's date and identity. Held and previously cancelled occurrences remain unchanged. Cancelling one occurrence does not cancel the series.

Replies, recorded attendance and retained occurrences are never deleted by a series change. Available remains a reply rather than attendance. Existing held/cancelled denominator rules remain in effect; no excused-absence policy is selected under Q09.

The shared reducer applies a whole series as one revision-checked command. Its stable command fingerprint handles exact replay and rejects an identity reused with different content. Both SQLite and PostgreSQL API adapters use the existing team/season authorization, transaction and request receipt path. Schedule jobs are queued separately for each affected occurrence with existing business-key deduplication; this does not establish notification delivery.

Verification covers pure calendar/atomicity/evidence rules, actual SQLite and restricted-role PostgreSQL HTTP requests, and 320 px browser journeys through both the local fictional journal and a fictional HTTP service. The sanitized evidence is `evidence/2026-10-21/training-series.json`. Native calendar/picker behavior and notification delivery are not claimed by these checks.
