# LongBall specification validation report

20 October 2026 | Pack version 0.1 | Checks on deliverables, not an application

The canonical specification contains 32,424 words. It preserves D01-D28 and F01-F28, specifies UI01-UI35 and REP01-REP07, and marks proposed defaults separately from confirmed decisions. App Expert (Mob) planning readiness remains 60/100. The 90% decision gate has not passed.

## Checks performed

| Check | Actual result |
|---|---|
| Decision/capability/screen/report coverage | All 28 D IDs, 28 F IDs, 35 UI IDs and 7 REP IDs are present. Semantic review checked the requested integrated scope and team-season separation. |
| Fairness examples | Fraction-based arithmetic passed for all 6 vectors, including individual tolerance, availability contributions, time conservation and the strict-grid infeasibility example. The example schedules were independently reviewed. |
| Results examples | Initial and corrected W/D/L, goals, difference and points calculations checked. |
| OpenAPI structure | YAML parsed; 87 paths, 103 uniquely named operations, 172 schemas and 176 internal references resolved. Path parameter definitions, required properties and array item declarations checked. |
| API/spec consistency review | Corrected goalkeeper objective order, handover re-anchoring, sequence continuity, adult-role eligibility, media scoping, publication policy propagation, report fields and 59/60-minute award timing. |
| Design tokens | JSON parsed. Seven specified text/background pairs exceed 4.5:1 by calculation. Actual rendered app states remain untested. |
| Visual booklet | Eight pages rendered and visually inspected. Selected final pages rechecked after revisions. Text bounding boxes remain within page bounds. No clipping or overlap identified. |
| Drawing source | Python syntax parsed. The drawing script was executed to produce the reviewed PDF. |
| Packaging | Source concept snapshot checksum recorded. Archive CRC and relative content paths checked before delivery. |

## Reproduce limited artifact checks

From the extracted archive, with PyYAML and PyMuPDF installed:

```text
python checks/validate_spec_artifacts.py .
```

This script is an artifact checker. It is not the future application test suite. It cannot establish a correct scheduling implementation, secure service, working native integration or app-store acceptance.

Full OpenAPI schema validation was not available in this environment. Run the selected OpenAPI 3.1 validator and generated-client/server contract tests at M0. YAML parsing and structural assertions do not prove full dialect conformance or service behaviour.

## Not implemented or tested here

No mobile repository, native binary, live API, identity provider, database, object store or deployed application was created. No application unit/integration/access tests, physical-device tests, outdoor usability studies, store submissions, restore exercises or penetration tests were run. Their pass/fail criteria are specified in the pack. No accounts were registered, domain purchased or operating expenditure incurred.

The reference architecture, performance goals, session policies, effort estimate and running-cost allowance remain proposals requiring engineering proof and the recorded owner decisions. Vendor documentation is evidence of described capabilities, not a benchmark or compliance certification.

## Source integrity

Concept snapshot: LongBall_Concept_Review_v0_12.docx, saved version 12.

SHA-256: d2fdd6a8d10e56cd4386cc486deb6d78de6171e6390e819a55b46dbfcb51e4c0

The original concept was not overwritten. The official FA Handbook is linked, not included in the archive.
