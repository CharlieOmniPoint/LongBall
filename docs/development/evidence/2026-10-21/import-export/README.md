# Roster/calendar browser proof

The final isolated development export passed on 21 October 2026. This is not a public release or native-device acceptance.

`index-f9dc4cc7991bdb25dcdace37b85f95b7.js` has SHA-256 `adaa31eb748fff66c61126bcc2e248d97008796ddde48520d919f09b8d17f3ef`. The browser used port 4384 and a newly created fictional SQLite HTTP service on port 4385. No application state was injected. The discovery document/tunnel were routed to that actual loopback service; all preparation and own-player requests used its normal authorization and mutation handlers.

Three groups passed:

- At 320 px, an invalid CSV row could not be confirmed; preview emitted no import command; explicit acknowledgement committed two distinct players with the same initials together in one command.
- At 320 px, a manager explicitly selected two events and downloaded an ICS containing timed and unknown-kickoff date-only entries without roster/results fields.
- At 390 px, a player exported a permitted own schedule entry and had no manager import control.

No browser page errors or horizontal overflow occurred. See [evidence.json](evidence.json) and the three screenshots. Physical native share sheets and production authentication are outside this proof.

Repeat by exporting the isolated app to `.local/import-export-web`, then running `node scripts/import-export-review.mjs` from the repository root. The script owns only ports 4384/4385 and a new unique fixture directory. It preserves earlier failures. The first run passed the import but waited on an obsolete refresh locator hidden by compact navigation; the harness now waits for the current enabled import control. The final run passed after the fresh-membership-denial guard was included.
