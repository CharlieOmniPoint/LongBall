# Review LongBall

24 October 2026 club expansion — development candidate, not yet published. The owner-requested account, club, formation, invitation and match-day additions extend the native iPhone/Android application and browser/tablet review. The original F01–F28, earlier usability changes and four Should features remain in scope. Final source/artifact identifiers and hosted results will be added after the current frozen candidate is checked.

## Shared review status

The last verified public build is [frontend `e706fa4` with backend `38e0879`](https://charlieomnipoint.github.io/LongBall/?v=e706fa4). It does not yet contain the club expansion. Its bounded API session ends at **01:22:39 GMT on 25 October 2026** (`01:22:39 UTC`). New Pages/API readiness, public checks and native binary builds are pending; no new feature is claimed live here.

Existing supplied credentials remain outside the app and documentation. In the new candidate, the previous Administrator account is labelled **Super Admin** using the same credentials; a separate Club Admin review account is supplied privately. Never enter real child data into this generated-data review.

## What the candidate adds

[The expansion register](club-expansion.md) records the full behaviour and authority boundaries.

- **Formation and advice:** choose playing format, type a traditional outfield pattern such as `4-4-2` or `3-2-1`, and review a positions-only pitch. Available eligible players and ranked preferences inform reviewable 65% primary / 35% secondary advice; impossible allocations remain visible and no player is moved automatically.
- **Five account types:** Super Admin, Club Admin, Manager, Player and Spectator. Club/system authority is server-owned; inherited Manager access is separate from the four appointed coach places. Club/team/season selection, U5–U21 teams, optional league names and sortable/filterable club reports follow current scope.
- **Spectator access:** scoped invitations can be shared as locally generated QR/link or composed email. First registration uses a username/four-digit PIN with weak-code refusal and bounded login/lockout. Spectators may join multiple teams and choose a player to support without receiving private Player records. An unauthenticated Player/Spectator access request grants no account or membership. [Access notes](spectator-access.md).
- **Team records:** genuine XLS roster download/previewed import preserves player identities; own/Manager FA IDs and staff-only validated PDF team sheets keep their scope. Known goalkeeper clean sheets come from accepted stint/goal evidence. Completed-game opposition ratings/notes are staff-authored, Player-readable and Spectator-denied.
- **Match-day controls:** a prominent next-substitution countdown lists the advised changes, with saved lead/volume settings and explicit per-device audio enablement. Substitutions remain manual; pause, uncertainty, stale advice and control/background changes suppress inappropriate tones. [Audio/device limits](substitution-alerts.md).
- **Presentation:** Spectator blue and Super Admin purple themes, team/context navigation and phone/tablet modes remain accessible. The compact match layout is undergoing final viewport/clock verification.

## Candidate checks and limits

Observed local results belong to the current working candidate; they are not deployment or final-commit acceptance:

| Check | Observed result / remaining check |
| --- | --- |
| Shared rules/platform | 914 tests in 110 files passed, including retained actions/outbox and empty administrative entry. |
| API | 454 cases passed with three explicit absent-HEIC-helper skips (457 total, 74 files). No full zero-skip HEIC run is claimed. |
| Static/contracts | Root/mobile TypeScript, lint, full runtime/canonical contracts and supplied archive checks passed; 127 new payload/security/format boundary cases passed. |
| New browser journeys | Six groups passed against a fresh actual SQLite API/worker, with zero reported page errors and five expected privilege denials. No fabricated feature DTOs were used. |
| Existing browser/tablet | Eight role/width journeys and 27 groups passed timer decrease/freeze assertions; a clipped timer was then found. The compact layout and nonvacuous geometry guards are fixed, with final rebuilt reruns pending. Tablet 36 journeys/two groups passed before that final layout fix and will be repeated. |
| Native | Android/iOS JavaScript exports passed before the final layout/boolean correction. Fresh final exports and actual binary builds are pending. Older binary results retain their own source scope; no install/device result is inferred. |

The full workspace dependency gate now has **two unwaived high findings, `node-forge` and `zod`**. Separately locked API/worker runtime and compiler audits reported zero vulnerabilities in their captured inputs. [Dependency evidence and compatible-update investigation](club-expansion-security.md) retain exact lock/source scope; those isolated passes do not waive the full gate.

Earlier [e706/38e](evidence/2026-10-24/past-game-replies/README.md), [tablet](evidence/2026-10-24/tablet-layout/README.md) and other feature proofs remain historical. Their one-high audit labels and old test totals describe those sources, not this expansion candidate. No paid provider or production service is provisioned.

## Deferred owner and device work

At the owner's instruction, Q05/Q09/Q10 verification, retention and support authority remain pending. SEC20/SEC21 privacy fulfilment and UI34 governed support/recovery therefore remain incomplete. Demo settings and fixtures do not approve production operating or audience policies.

Physical iPhone/iPad/Android testing is deferred. Tablet rotation, split view, on-screen/hardware keyboards and screen readers still need device evidence. Background timing, encrypted storage/backup exclusion, OS authentication/prompts, notifications, battery/Focus behavior and signing/installation still require their own evidence. Production identity, storage, delivery and operating services have not been provisioned. This review is for generated-data functionality feedback.

Historical source proofs remain in the [build register](full-build-plan.md), [earlier public account review](evidence/2026-10-24/public-account-review/README.md), [workflow checkpoint](evidence/2026-10-23/workflow-retention/README.md), [traceability](traceability.md) and [decision register](decisions.md).

## Run in the development workspace

```bash
cd /workspace/LongBall
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

The development API defaults to `http://127.0.0.1:4310` on that machine. Cloud localhost is not a sharing address. Saved CSV/PDF exports additionally require the separate worker using the same database, export key and TTL; see [protected reports](report-exports.md) and [runtime setup](../../infra/runtime/README.md). Device and dependency gates remain separate from `pnpm check`.
