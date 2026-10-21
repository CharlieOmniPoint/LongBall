# Connected voting and photo safety browser evidence

Passed on 21 October 2026 at 320 × 844 and 390 × 844. This is evidence for an uncommitted development candidate, not a release or physical-device acceptance.

The normal browser export was `index-ed08a1bd6e5fdc99dbe3a846cdd6e670.js`, SHA-256 `0915cc3580c6b2623593393d535c053f4b1b5b5570d0b1b256222625c2d76c76`. The actual TypeScript HTTP service ran on loopback port 4359 with a new disposable SQLite fixture. [evidence.json](evidence.json) records the handler source hashes and the completed assertions.

Four groups passed at each width:

- Selecting a teammate remains a local draft. Confirm vote records it; Change vote retains the old choice until a second explicit confirmation. Each journey produced exactly two ballot commands.
- Report photo and Report uploader submit independent targets. The current account sees its own reference and status without reporter identity being exposed in the filtered DTO.
- Opening the gallery-only hide confirmation and cancelling have no effect. Explicit confirmation filters that uploader from this account's gallery while preserving the separately permitted official report data.
- Restoring the uploader returns the permitted gallery photo and retains the account's concern references.

There were no browser page errors or horizontal overflow. The published fictional image went through actual PNG prepare, PUT, ClamAV scan, completion and manager publication over HTTP. The fixture enabled fictional community sharing before listening; the separate official-match sharing policy remained unapproved. No production sharing or moderation policy was accepted.

Repeat with `node scripts/community-ui-review.mjs` from the repository root, with the current browser export on port 4173 and ClamAV on port 53310. The script refuses existing fixture databases and preserves failed runs under `.local/community-ui-review`. It waits between widths to respect the existing account request limit. The assertions are reusable through `scripts/connected-community-checks.mjs`.

Earlier harness runs are retained: one comparison included the report envelope's changing `generatedAt`, and a rapid second-width run hit the service's unchanged HTTP 429 limit after the first width passed. The final comparison excludes only that envelope timestamp, and the final run respects the request window. Neither incident required a product change.

This evidence uses public fictional identities. Real-provider authentication, physical iPhone/Android interaction, keyboard behavior and native accessibility remain separate checks.
