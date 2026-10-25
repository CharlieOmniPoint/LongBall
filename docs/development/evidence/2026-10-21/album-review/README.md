# Explicit game album browser/HTTP evidence

Run `20261021100943644` passed all five connected journeys together with zero browser runtime errors, at a 390×844 viewport against fresh fictional SQLite APIs on ports 4320/4321. It ran after concurrent export jobs had finished. No storage was reset, reseeded or rewritten to force a pass. The existing production-trial listener on 4310 was untouched.

- Web entry: `index-574b3e4289da41fb548779d3b27caa53.js`, SHA256 `34f026256d1eb1dca1a1686a6d2a02a4ec2f8389c715a9c70497c224abb92427`.
- API bundle: SHA256 `bcf92d7d6937c965c88637c089168636122c29c06b817291faee480ebe7df558`.
- Reproduce with that web bundle served on 4173, then `node scripts/connected-review.mjs`.

Case 04 required an explicit game selection before image upload. The UI prepared and uploaded a generated fictional PNG for Maple, explicitly closed its retained request capability, then selected Willow and prepared another upload. Captured real HTTP bodies used the two different selected game IDs and captions. The other game chooser was disabled during a retained request. A read-only SQLite check confirms distinct request IDs and persisted `media_uploads.match_id` values matching those choices. Both rows remain private, with status `uploaded` and failure code `SCANNER_REQUIRED`; published gallery rows and counts were unchanged. This proves upload targeting and fail-closed behavior, not antivirus operation or photo publication. `quiet-run-private-metadata.json` contains only these fictional metadata fields.

The same run also passed canonical match/retry/retrospective correction, handover/sequence/quarantine/reconciliation, service preparation/results/privacy and durable workspace outbox response-loss/reload/exact retry. The earlier detailed history-review evidence remains separate.

Earlier incidents are retained, not replaced by the final pass:

| Run | Observation |
| --- | --- |
| `20261021095547499` | Cases 01/02/03/05 passed. Case 04 stalled before album access on “Opening the local Roma fixture…” for 20 seconds. No browser exception was reported. The failed context closed before detailed storage diagnostics were installed. |
| `20261021100336954` | Cases 02/03/05 passed. Case 01 exposed a test-clock race: installing and pausing at the exact same timestamp could request a pause in the past. Case 04 then correctly refused to proceed without two completed permitted games. The harness now uses the existing baseline pattern: install an hour earlier, then pause at the intended time. |
| `20261021100522852` | Cases 01/02/04/05 passed, including the two-game metadata check. Case 03 timed out clicking the visible enabled reschedule button; its screenshot and full result are retained. No application exception was reported. |

A read-only lifecycle review found no proven cold-start race. Twenty independent cold contexts passed without reload or reset (`cold-start-results.json`). Pass-through diagnostics now record IDB open/upgrade/blocked/transaction completion/abort/error, timer/animation progress, and bounded read-only database/lock/identity summaries before closing any future failed startup context. The startup and click incidents' causes remain unproven; the quiet run does not establish that they were fixed. Separate malformed-device and fixture-identity guards subsequently [passed three explicit corruption/reopen/Retry browser fixtures](../storage-guards/README.md) on a newer guard build; that is not a diagnosis of the cold-start incident.

Native SQLCipher, continuous clock/reboot behavior, background alerts, real identity-provider operation, malware scanning and approved production sharing/authority policies require their own evidence. Q21 is not approved by this test, and the Q08 final reconciliation apply gate remains closed.
