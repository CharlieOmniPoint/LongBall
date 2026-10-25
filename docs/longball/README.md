# LongBall mobile design and build pack

Version 0.1 | 20 October 2026 | Based on Concept Review v0.12, saved version 12

Start with the [visual design booklet](LongBall_Mobile_Design_Booklet_v0_1.pdf), then read the [canonical build pack](LongBall_Mobile_Build_Pack_v0_1.md). The archive is a mobile specification and developer handover. It does not contain a built app or an approved release.

| File | Purpose |
|---|---|
| LongBall_Mobile_Build_Pack_v0_1.md | Complete product, UX, match rules, reports, data/API, security, quality, delivery and operating specification. |
| LongBall_Mobile_Design_Booklet_v0_1.pdf | Eight illustrated mobile screen states with interaction notes. Fictional players and match data. |
| contracts/openapi.yaml | OAS3.1 resource/event contract. Requires toolchain validation and implementation tests before code generation is trusted. |
| contracts/design-tokens.json | Concrete proposed colours, typography, spacing and motion. |
| contracts/fairness-vectors.json | Six independently checked mathematical examples, not a tested application solver. |
| BUILD_START.md | Copyable Codex implementation prompt, generated from the canonical pack. |
| PROPOSED_AGENTS.md | Suggested future repository guidance; not an installed instruction file. |
| .env.example | Configuration names and invalid/empty placeholders only. |
| checks/validate_spec_artifacts.py | Reproducible limited artifact checker, not an application test suite. |
| validation-report.md | Checks actually performed on these deliverables and the tests still required. |
| design/build_visual_booklet.py | Editable ReportLab drawing source for the booklet. |
| source/LongBall_Concept_Review_v0_12.docx | Provenance snapshot of the prior concept. |

All F01-F28 remain in the integrated pilot scope. The proposed first manager increment is an intermediate delivery step. The architecture recommends native iPhone/Android apps with a durable controller journal and a shared backend. Initial user access stays free.

Current App Expert (Mob) planning readiness is 60/100. The pack is provisional because operating ownership, recovery verification, data lifecycle, competition policy and several exceptions remain unresolved. The canonical pack distinguishes confirmed decisions from proposed defaults and identifies work that can safely begin with synthetic data.

The visual booklet is original vector artwork, using fictional identities and embedded DejaVu fonts. Production UI uses platform system fonts. Club/team logos and final brand/store assets must be supplied or created with appropriate rights. No Subbuteo artwork or actual children's photographs are included.

To revise the booklet, install a compatible ReportLab package in an isolated Python environment and inspect the source's output-path/font settings. Change the output destination before running it. These drawing dependencies are not the future app toolchain. The source is supplied for editing, not as a packaged application build script.

The FA Handbook is linked in the specification and is not redistributed in this archive. Sources and vendor capabilities were checked on 20 October 2026; recheck dynamic store/SDK/pricing requirements at build freeze.
