# Player fixture details (UI07)

The canonical mobile pack's UI07 requires opposition, home/away, location, arrival/kick-off, format, duration and the player's own availability response.

Both connected own-player preparation endpoints now use one explicit projection. It adds the fixture's saved `arrival`, `format` and `plannedHalfDurationMs`, while retaining only the current profile's response, selection and actual attendance. Current player/team/season authorization checks stay at the service boundary. A fresh client parser checks that same scope and rejects private extra fields before the UI adopts a response.

The connected schedule and fictional player fixture cards display these recorded fields. Duration is labelled **Planned duration**, for example `2 × 17 min 30 sec`; it does not imply actual half endings. Unknown old fields stay null and display **Not recorded**. New team defaults never fill or replace an existing fixture's plan. An availability reply remains separate from actual attendance.

Five pure tests and four actual HTTP tests passed, covering SQLite and restricted PostgreSQL roles, private-field filtering, scope/refusal and revocation, saved detail retention through replies, and changes to team defaults. Root/mobile TypeScript and scoped lint passed. Evidence is in [player-fixture-details.json](evidence/2026-10-21/player-fixture-details.json).

No migration, authority policy, provider configuration or native device behavior changed. The new UI still needs the parent integration build; no fresh browser screenshot or physical-device claim is made here.
