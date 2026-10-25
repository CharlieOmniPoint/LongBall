# Candidate 6 Club Admin smoke

All five targeted checks passed from **2026-10-25T22:47:23.096Z** to **2026-10-25T22:47:42.958Z** on the separately pinned candidate 6 client. The original sanitized report and tablet screenshot are copied unchanged, including their original file timestamps. `SHA256SUMS` verifies their content and this note.

This supplements the full 37-check candidate 4 journey in the parent folder. That earlier report, fingerprints and screenshots have not been relabelled or changed.

The smoke authenticated a generated Club Admin, read its authorised directory, opened the phone Team directory with Open/Manage controls, loaded tablet club reports and tested the already-selected-club regression, read Account Help/Privacy/real request status with internal references collapsed, then performed real logout. No privacy request or other business write was submitted. There were no HTTP failures, page errors, transport errors or new findings.

The candidate 6 compiled-client SHA256 is `91c5b2b6013ee0f496c9e13d73bb59b073d0d8b32e0bf0c56f658cf5908b4813`. API, worker, helper and scenario hashes remain in `report.json`; the artifact stability assertion passed. The recorded HEAD and dirty-tree status describe the source at execution, not a later commit.

The same browser/loopback SQLite, generated-account and native-device boundaries as the parent evidence apply. This is a targeted regression check after later gallery/keyboard review changes, not another full 37-check run or a claim of physical-device testing. Q05/Q09/Q10 remain pending.

Reproduce against matching built artifacts:

```sh
source scripts/dev-env.sh
LONGBALL_PERSONA_PHASE=candidate6-smoke node scripts/persona-club-admin-smoke.mjs
```
