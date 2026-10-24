# Review LongBall

24 October 2026 usability and match-day update. Product source `0265b4880d9808fb393851e3377ac5a34264b2c7`, tree `1508d216e99da784823f9bcaf9341cfcd2a895d8`, development branch `dev/longball-m0-journey`; draft [PR1](https://github.com/CharlieOmniPoint/LongBall/pull/1). The native iPhone/Android clients and browser review share application rules. F01–F28, the four Should features, canonical match rules and approved visual direction remain in scope.

## Open the shared review

Open **[LongBall](https://charlieomnipoint.github.io/LongBall/?v=0265b48)** and sign in with an existing supplied username and password/passcode. Credentials stay outside app screens and repository documentation. The role is visible in the header; its logout icon remains available. Select the team badge for Team Overview.

The lasting Pages address uses a separate bounded review API. The current [API](https://termination-operated-delaware-cameras.trycloudflare.com/) began at **13:33:15 BST on 24 October 2026** (`12:33:15 UTC`) and expires at **18:33:15 BST** (`17:33:15 UTC`). A later renewal creates fresh sample records and ends earlier sessions. No paid hosting has been provisioned.

Roma U10 has thirteen named players, Oak on 10 October (2–2), Hill on 17 October (3–1), Maple on 24 October and Oak on 31 October. The two upcoming games remain unplayed; availability, selection and actual attendance are separate. The supplied credentials are unchanged.

## What to try

The [seventeen-item implementation and acceptance register](2026-10-24-usability-improvements.md) maps every request to behavior and review steps.

- Manager or Administrator: cancel or remove an unplayed game from Schedule after reviewing the reason. Recorded or claimed games are protected.
- Manager: Team → Saved player setups holds up to three named setups. A fixture can copy one into its draft. Live lineup preparation can auto-fill checked-in available players using approved eligibility, goalkeeper policy and preferences.
- Manager: More → Team settings → Manage team positions configures active two-letter codes. Player editing has Select all approved eligibility. Existing history and saved snapshots retain their original positions.
- Player: My Stats shows that player's recorded playing, position and scoring statistics. Manager/Administrator Stats adds individual summaries and formation views of season position time/percentages.
- Player: Home or More → Match feedback offers 1–5 enjoyment stars and up to 256 Unicode characters after trusted full time until London midnight that completion day. Only the author and current team Managers can read it; Administrators and Spectators cannot. Earlier saved feedback stays readable.
- Spectator: Home, Scores, Results, Photos and Account give direct navigation. Home offers today's current game or the next fixture. The team badge works for every role.

Squad replies, player actions and preferences are more compact, with paired Edit/Archive actions and optional details. UK dates use short years; all calendar boundaries use Europe/London with daylight-saving changes. Canonical dates and machine inputs keep their full ISO values. Visible dataset labels and the inconsistent notice font are removed.

## Verification and limits

The [dated evidence](evidence/2026-10-24/team-usability/README.md) identifies exact sources, assets, suite scope, earlier failures and later passes. Focused and aggregate counts overlap and are not added together.

| Check | Observed result |
| --- | --- |
| Shared rules/platform | 848 tests in 99 files passed. |
| API | All 424 host cases validated with real disposable PostgreSQL and maintained HEIC: 423 initial passes, then the sole stale expected-ledger test corrected to versions 2–20 and passed on a targeted rerun. Product API inputs remained unchanged. |
| Migrations/contracts | 30 actual PostgreSQL migration checks across 6 files passed. Canonical/runtime OpenAPI, source packaging, lint and root/mobile TypeScript passed. |
| Browser | Original match-clock journey passed 10 groups. Maintained credential demo passed 8 role/width journeys and 24 check groups. New improvement suite passed 8 journeys and 4 composite feature/privacy groups. Source-bound supplementary results are in the evidence index. |
| Public browser | Approved unmocked role checks cover all four accounts at 320/390px, actual login/logout/revocation, private-data denial, typography, layout and browser-store checks. The exact final-source result is in the evidence index. |
| Native | Android and iOS Hermes exports passed. Actual Android Debug arm64 and unsigned x86_64 iOS Simulator builds are source-bound in native evidence. No binary upload, installation or hardware result is claimed. |
| CI/image | Exact product-tree CI functional checks and production-image acceptance passed. CI has 421 API passes and 3 explicit absent-HEIC-helper skips; the host coverage above has no skips. Dependency enforcement remains failed. |

One existing unpatched high `node-forge` advisory remains on the unchanged dependency lock. No suppression or release exception is approved.

## Deferred owner and device work

At the owner's instruction, Q05/Q09/Q10 verification, retention and support authority remain pending. SEC20/SEC21 privacy fulfilment and UI34 governed support/recovery therefore remain incomplete. Demo settings and fixtures do not approve production operating or audience policies.

Physical iPhone/Android testing is deferred. Device background timing, encrypted storage/backup exclusion, OS authentication/prompts, notifications, battery/Focus behavior and signing/installation still require their own evidence. Production identity, storage, delivery and operating services have not been provisioned. This review is for generated-data functionality feedback.

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
