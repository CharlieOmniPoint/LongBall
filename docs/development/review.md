# Review LongBall

24 October 2026 player-availability update. Frontend/review source `e706fa4c9ba55aaf6d5783f3c74aa68a9415cc39` uses backend source `38e08797755fe5ca154786c0ad2130888f8b6d1a`. Native iPhone/Android, tablet layouts, the seventeen usability requests, F01–F28 and all four Should features remain in scope.

## Open the shared review

Open **[LongBall](https://charlieomnipoint.github.io/LongBall/?v=e706fa4)**. The [compatible-frontend deployment](https://github.com/CharlieOmniPoint/LongBall/actions/runs/40129608075) passed for request `ac7fcaa634a13606537a950e4f71929559c10f74`; the [final focused public proof](evidence/2026-10-24/past-game-replies/public-e706fa4.json) passed Player Past/Upcoming at 320/390px and a fresh rejected-write check. The [Roma API](https://bent-seller-ministries-strengths.trycloudflare.com/) is ready from **21:22:39 BST on 24 October** (`20:22:39 UTC`) to **01:22:39 GMT on 25 October** (`01:22:39 UTC`), across the clock change. Its ready marker and running job were unchanged before/after the corrected frontend publication. The tested entry JavaScript SHA256 is `60b03265…d2103`, stable before/after. Supplied credentials are unchanged; the previous `silence-stainless` session was cancelled and is historical. No paid hosting is provisioned.

Use an existing supplied username and password/passcode. Credentials stay outside app screens and repository documentation. The role is visible in the header; its logout icon remains available. Select the team badge for Team Overview.

Roma U10 has thirteen named players, Oak on 10 October (2–2), Hill on 17 October (3–1), Maple on 24 October and Oak on 31 October. The two upcoming games remain unplayed; availability, selection and actual attendance are separate. The supplied credentials are unchanged.

## Past games: recorded availability only

Player → Schedule → Past games shows recorded replies and attendance without availability actions. Today/future scheduled unplayed games keep reply controls; the Europe/London date and accepted game evidence determine eligibility. Passing planned kickoff alone does not finish a game. Home and Schedule also honour a terminal accepted summary when canonical state still says preparation. Both SQLite/PostgreSQL reject fresh closed-game replies; exact receipt replay, Manager historical corrections and training remain supported. [Rule and evidence](past-game-replies.md).

## What to try

Manager and Administrator: open the **layout icon in the header** to choose **Auto**, **Phone** or **Tablet**. Auto selects tablet layout when the window is at least 768px wide with a 600px short edge; Phone keeps the narrow workspace; Tablet uses the available width and falls back safely where necessary. Columns and the navigation rail adapt to window space and text size. The choice is shared across staff roles on this device. Player/Spectator layouts remain single-column. [Tablet guide](tablet-layout.md). Unsaved fields and match state survive layout changes; these changes send no football command.

The [seventeen-item implementation and acceptance register](2026-10-24-usability-improvements.md) maps every request to behavior and review steps.

- Manager or Administrator: cancel or remove an unplayed game from Schedule after reviewing the reason. Recorded or claimed games are protected.
- Manager: Team → Saved player setups holds up to three named setups. A fixture can copy one into its draft. Live lineup preparation can auto-fill checked-in available players using approved eligibility, goalkeeper policy and preferences.
- Manager: More → Team settings → Manage team positions configures active two-letter codes. Player editing has Select all approved eligibility. Existing history and saved snapshots retain their original positions.
- Player: My Stats shows that player's recorded playing, position and scoring statistics. Manager/Administrator Stats adds individual summaries and formation views of season position time/percentages.
- Player: Home or More → Match feedback offers 1–5 enjoyment stars and up to 256 Unicode characters after trusted full time until London midnight that completion day. Only the author and current team Managers can read it; Administrators and Spectators cannot. Earlier saved feedback stays readable.
- Spectator: Home, Scores, Results, Photos and Account give direct navigation. Home offers today's current game or the next fixture. The team badge works for every role.

Squad replies, player actions and preferences are more compact, with paired Edit/Archive actions and optional details. UK dates use short years; all calendar boundaries use Europe/London with daylight-saving changes. Canonical dates and machine inputs keep their full ISO values. Visible dataset labels and the inconsistent notice font are removed.

## Verification and limits

[CI 40127475188](evidence/2026-10-24/past-game-replies/ci-e706fa4.json) passed for exact frontend tree `15e95c43bea53a9014cae1fb67163781cf5e84d6`: 855 shared tests/101 files, 427 API passes plus three explicit absent-HEIC-helper skips (430/65 files), 30 migrations/6 files, ten M0 groups, eight demo journeys/26 groups and 36 tablet journeys/two groups. Runtime-image acceptance passed. No full 430-case maintained-HEIC host pass is claimed.

The 26th demo group deliberately mocks one filtered-records GET as completed while the real canonical match stays in preparation. It verifies Home/Schedule reply suppression, retained details, another unplayed game's controls and restoration of actual records without a preparation write. This is client-projection evidence; the earlier 25 actual API/worker flows and targeted backend-guard checks retain their own scope. The current CI rollup and separately retained earlier raw reports are linked in the [evidence register](evidence/2026-10-24/past-game-replies/README.md).

Native JavaScript exports passed for `e706fa4`. Actual Android Debug arm64 and unsigned x86_64 iOS Simulator builds passed for `38e0879`; those binary results are not relabelled as frontend `e706fa4` compilation or physical proof. The corrected frontend request produced no new backend run. Earlier request placement triggered a renewal, and an initial backend bootstrap failed during a branch push race; [deployment notes](compatible-frontend-review.md) preserve those outcomes.

Earlier [38e availability/public/native proofs](evidence/2026-10-24/past-game-replies/README.md) and [7da tablet proofs](evidence/2026-10-24/tablet-layout/README.md) remain historical; the new public result has its own frontend/backend binding and does not reattribute those earlier reports.

One existing unpatched high `node-forge` advisory remains on the unchanged dependency lock. No suppression or release exception is approved.

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
