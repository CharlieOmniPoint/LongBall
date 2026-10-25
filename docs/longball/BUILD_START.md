# LongBall BUILD_START

Generated from the canonical build pack, version 0.1. Read the full pack before use.

```text
Build LongBall using Codex from this mobile specification. Begin with synthetic data and the M0 feasibility slice. This instruction authorises implementation only when the owner gives it to the builder as a build request. The design pack itself has not authorised spending, live-data onboarding or publishing.

Read, in order:
1. README.md and LongBall_Mobile_Build_Pack_v0_1.md, including decisions, readiness, open issues and all behavioural rules.
2. LongBall_Mobile_Design_Booklet_v0_1.pdf and contracts/design-tokens.json.
3. contracts/openapi.yaml and contracts/fairness-vectors.json.
4. PROPOSED_AGENTS.md, .env.example and validation-report.md.
5. source/LongBall_Concept_Review_v0_12.docx only when earlier provenance needs checking. The mobile pack labels its proposed refinements explicitly.

First inspect the actual repository and its existing AGENTS.md files. Preserve user changes. If no application exists, create the proposed monorepo structure: apps/mobile, apps/api, apps/worker, packages/domain, packages/contracts, packages/ui, packages/testing, infra, docs and fixtures. Record architecture decisions, unresolved owner decisions and a traceability register using the existing D/F/UI/ME/MT/SEC/REP/QL identifiers. Do not silently accept open proposals.

Recommended route: TypeScript Expo/React Native native development builds, pure shared match reducer/planner, encrypted SQLite event journal, typed Node API, PostgreSQL, private media gateway/object storage and PostgreSQL-backed jobs. Evaluate Keycloak OIDC with system-browser PKCE, username-only child identities and stronger verified-adult authentication. Keep application permissions separate from identity-provider roles. Railway is a proposed host; do not provision it just because it appears in the specification.

M0 first: select and pin compatible stable dependency versions, the package manager, lockfile and required native toolchains. Bootstrap synthetic Roma data. Prove clock anchoring/resume, encrypted SQLite activation and wrong-key refusal, durable event/outbox transactions, device key handling, backup exclusions and foreground/local-notification behaviour on an iPhone and Android phone. If devices or signing are unavailable, implement the deterministic/local parts and report exactly which proofs remain blocked. Do not claim emulator results establish physical-device behaviour.

Then deliver M1 identity and preparation; M2 complete live-match recording and recovery; M3 player, training, reports and retrospective results; M4 spectator, voting and moderated photos; M5 controlled Roma beta; M6 club release. P1 is an intermediate manager slice. All F01-F28 are the target integrated pilot. M5/M6 require the applicable ownership, policy, account and release decisions.

Preserve these constraints: one authoritative match controller; manual half endings and restart; actual active time; recorded events never changed merely to improve fairness; individual +/-10% target bands; confirmed goalkeeper exception and sharing; no automatic substitutions; separate team-season figures; private ballots; final award due by original full time plus 60 minutes; proposed voting cutoff plus 59 minutes remains a proposal; no named teammate minutes/attendance for players; no pending-media disclosure; no child-account promotion into adult authority; versioned competition sharing policy, including derived-score restrictions; free initial user access and no payments.

Implement and run the script contract from the pack: frozen-lockfile install, lint, typecheck, unit, integration, contract, access, migration, synthetic-fixture, native-development-client, end-to-end and build commands. Add meaningful tests at the behavioural boundaries, not tests that only repeat implementation. Validate the OpenAPI with the selected toolchain before generation and resolve any conflict with confirmed requirements. Use the supplied fairness vectors as expected mathematical examples, not proof of a complete solver.

Deliver complete journeys through UI, API, persistence and tests. Test denial, expiry, retry, duplicate writes, offline recovery, handover away and back, uncertain clocks, corrections, stale viewers, historical unknowns, moderation, erasure, migration and restore. Use actual test evidence and document any defects. Never reset a rejected branch or overwrite an unsynchronised journal to obtain a passing result.

No secrets in source or EXPO_PUBLIC fields. No real children/photos in development or staging. No ads, chat, payments, AI ability scores or public sharing added to scope. Honour existing authorisation and request only genuinely missing decisions or external-action authority. Prepare concrete reviewable work before any required release approval.

At each milestone report what changed and why, files and commit, exact checks run, device/OS/network conditions, passed and failed results, defects, remaining decisions, operating costs and the next eligible milestone. Separate specification completeness, implemented functionality and release readiness.
```
