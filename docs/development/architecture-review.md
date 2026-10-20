# Architecture and M0 preparation

The supplied [canonical build pack](../longball/LongBall_Mobile_Build_Pack_v0_1.md) is the product and behaviour reference. Its D01–D28 decisions remain distinct from proposed technical choices and unanswered Q-series decisions. The extracted files in `docs/longball` preserve the archive; `PROPOSED_AGENTS.md` remains reference material.

The repository now implements the local synthetic initial journey and M0 clock, journal and notification experiments. See the [review guide](review.md), [scope/proof register](implementation-scope.md) and [full capability traceability](traceability.md). It does **not** complete physical M0, implement all F01–F28, or establish release readiness. No paid hosting, production credentials, real player data or store enrolment is required.

## Architecture to develop

Follow the pack's [recommended implementation boundary](../longball/LongBall_Mobile_Build_Pack_v0_1.md#recommended-implementation-boundary) and [service boundaries](../longball/LongBall_Mobile_Build_Pack_v0_1.md#service-boundaries):

| Boundary | Direction and purpose | Timing |
| --- | --- | --- |
| Mobile | Expo SDK 58 / React Native TypeScript native development build. Local SQLite journal, SecureStore key and native clock/notification adapters. | M0 feasibility work |
| Shared domain | Pure deterministic reducer/planner; integer elapsed milliseconds and exact target calculations; no native, HTTP or database imports. | M0 deterministic experiments, then M2 match engine |
| Contracts | Validate supplied OpenAPI 3.1 before generating client/server types. Keep mathematical examples separate from application tests. | Prepared validation, implementation later |
| API | Typed Node/Fastify service with current account, team, object and controller checks. | M1 onward |
| Persistence and worker | PostgreSQL domain records, immutable match events, transactional outbox and jobs. One API and one worker initially; no Redis needed. | M1 onward |
| Identity and media | Evaluate Keycloak OIDC with system-browser PKCE; separate identity and domain permissions. Private object storage and an authenticated media gateway. | M1 identity; M4 media |

Pin Node **24.19.0**, pnpm **11.25.0** and exact tested dependency versions in the repository. SDK 58 is the selected stable compatibility line; its installed package metadata and generated native projects govern actual React Native, Android SDK/JDK and Xcode requirements. The pack's proposed iOS 17+ / Android 12+ pilot support still needs a phone survey. Native iOS compilation requires macOS/Xcode; this Linux cloud workspace cannot prove iPhone behaviour. See [reproducible build and configuration](../longball/LongBall_Mobile_Build_Pack_v0_1.md#reproducible-build-and-configuration).

Use the proposed layout: `apps/mobile`, `apps/api`, `apps/worker`, `packages/domain`, `packages/contracts`, `packages/ui`, `packages/testing`, `infra`, `docs`, `fixtures`. Native storage and clock adapters belong outside `packages/domain`; share contracts rather than database access code with the app. API, worker, identity and storage services can be added as the corresponding milestone needs them.

## Synthetic Roma baseline

Prepare 13 explicitly fictional roster records, with stable synthetic identifiers and no contact details, photographs or dates of birth. Use synthetic labels such as Player 01–Player 13 rather than copying actual Roma children. Scenario fixtures should select eight or nine available players, seven pitch places, and two planned 25-minute halves (D02, D11, D16). Include separate one-fixed-keeper and two-shared-keeper scenarios, a late arrival and known unavailable players; preserve availability, attendance and actual participation as different facts.

The supplied [six fairness vectors](../longball/contracts/fairness-vectors.json) are expected arithmetic examples. They do not validate position feasibility, a complete planner, durable storage or native behaviour. The [artifact checker](../longball/checks/validate_spec_artifacts.py) is similarly limited to the design pack.

## M0 evidence still to collect

The [M0 milestone](../longball/LongBall_Mobile_Build_Pack_v0_1.md#delivery-increments-and-release-gates) requires a disposable synthetic native experiment plus an iPhone and Android physical-device report. All device items below remain **pending** until run; installing packages or starting Metro does not satisfy them.

| Requirement | Required experiment and evidence | Traceability |
| --- | --- | --- |
| Clock continuity | Anchor active time to a continuous native clock; test sleep, lock, process restart, wall-clock changes and reboot. Unproved continuity must require recovery rather than guessed minutes. | ME11–ME12, MT17–MT18, QL02 |
| Encrypted journal | Enable `expo-sqlite` `useSQLCipher` in a native development build; require nonempty `PRAGMA cipher_version`; create, reopen and demonstrate wrong-key refusal. Expo Go is unsuitable. | PL10 |
| Key and backup handling | Generate the database key independently of the four-digit local PIN, retain it in SecureStore, and inspect/test database, journal/WAL and SecureStore backup exclusions. Test lost-key and migration paths without discarding unsynchronised events. | PL10, SEC05 |
| Durable writes and replay | Commit event, sequence allocation, local projection and outbox atomically. Inject failures around commit/acknowledgement; retry without duplicate events and retain rejected branches. | ME50–ME51, DS11, MT01/MT17/MT31, QL01 |
| Alerts | Test foreground 90/60/30/0 warnings, cancellation on pause/replan, denied permission, silent/Focus settings, screen lock, force-stop and battery restrictions on each phone. Document observed limits. | ME60, PL04–PL05, MT21–MT22 |
| Offline rehearsal | Run a synthetic two-half match in airplane mode, kill/reopen the process, reconnect and reconcile. Record device, OS, build, connectivity and actual outcomes. | D25, MT17, QL01–QL02 |

Local preparation should run the frozen-lockfile install, lint, typecheck, available unit/contract checks and synthetic-fixture validation. Add integration, permission, migration, native end-to-end and build checks as their implementations exist. A missing suite must be recorded as unimplemented or unrun, never represented by an empty successful command. The complete future [script contract](../longball/LongBall_Mobile_Build_Pack_v0_1.md#reproducible-build-and-configuration) remains the target.

## Decisions that remain open

Synthetic development can proceed while these are unresolved. Record any experiment-specific assumption explicitly; do not convert it into a confirmed product rule.

| References | Decision needed before the affected live workflow |
| --- | --- |
| Q05 | Household recovery verification and account-level authority across teams. |
| Q06–Q08 | Substitution defaults; keeper-policy transitions, under-strength and abandoned games; offline grants, reconciliation authority and background-alert expectations. |
| Q09–Q10 | Data/controller responsibilities, age collection, retention, operator, budget, support and account ownership. |
| Q14–Q15 | Shared display labels and season renewal; acceptance of the proposed full-time +59-minute ballot cutoff, preserving the confirmed +60-minute finalisation deadline. |
| Q18/Q20/Q21 | Exceptional results, final branding, and the league/competition policy for sharing U10 results and derived summaries. |

Keep real-data activation, hosting purchases, production provisioning and publication outside this preparation. Full physical-device evidence and relevant owner decisions remain required before claiming M0 or pilot readiness.
