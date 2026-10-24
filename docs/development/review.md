# Review LongBall

24 October 2026 tablet update. Product source `7da2226a2b24a878ea2ac1c6cb55fe07df33a220`, tree `c77fb0240e7565fa7cb86936992d0f03dadaccc1`, development branch `dev/longball-m0-journey`; draft [PR1](https://github.com/CharlieOmniPoint/LongBall/pull/1). The native iPhone/Android clients and browser review share application rules. The earlier seventeen usability requests, F01–F28, four Should features, canonical match rules and approved visuals remain in scope.

## Open the shared review

Open **[LongBall](https://charlieomnipoint.github.io/LongBall/?v=7da2226)**. The Pages workflow deployed tablet source `7da2226a` at 18:14:12 UTC on 24 October; the [public-browser proof](evidence/2026-10-24/tablet-layout/public-browser-7da2226a.json) passed all four roles at phone, tablet portrait and tablet landscape sizes. The [bounded API](https://drinks-motel-reply-washington.trycloudflare.com/) is ready from **19:13:31 BST on 24 October** (`18:13:31 UTC`) to **00:13:31 BST on 25 October** (`23:13:31 UTC` on 24 October). The recorded ready marker and transport are in the [runtime proof](evidence/2026-10-24/tablet-layout/runtime-7da2226a.json); the independent browser report separately verifies the deployed source and API. Pages persists independently; no paid hosting is provisioned.

Use an existing supplied username and password/passcode. Credentials stay outside app screens and repository documentation. The role is visible in the header; its logout icon remains available. Select the team badge for Team Overview.

Roma U10 has thirteen named players, Oak on 10 October (2–2), Hill on 17 October (3–1), Maple on 24 October and Oak on 31 October. The two upcoming games remain unplayed; availability, selection and actual attendance are separate. The supplied credentials are unchanged.

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

The [tablet evidence](evidence/2026-10-24/tablet-layout/README.md) records exact sources, artifacts and remaining gates. Local and matching-product CI checks passed the full tablet suite. The external browser matrix passed 12 role/viewport entries and 18 keyboard layout choices; current Android Debug arm64 and unsigned x86_64 iOS Simulator compilations both passed for published source `7da2226a`. Focused and aggregate counts overlap and are not added together.

| Check | Observed result |
| --- | --- |
| Shared rules/platform | Matching-product CI passed 851 tests in 100 files. |
| API | Matching-product CI passed 421 cases with 3 explicit absent-HEIC-helper skips (424 cases, 65 files). The unchanged API artifact retains the earlier 424-case host coverage with maintained HEIC: 423 initial passes plus the corrected stale expected-ledger case on a targeted pass. These are separate evidence scopes. |
| Migrations/contracts | Current CI passed 30 migration checks across 6 files, lint/root/mobile TypeScript, canonical/runtime contracts and source checks. |
| Tablet browser | Clean local and matching-product CI passed 36 role/viewport journeys and two preference/draft/clock groups. The local pass captured 39 screenshots with no HTTP/runtime/transport failures and exact journal/outbox continuity during layout changes. |
| Existing browser journeys | Current CI passed ten ordinary M0 groups and eight maintained demo role/width journeys with 24 groups. The earlier seventeen-improvement suite retains its own eight-journey/four-group source proof. |
| Hosted review | Actual unmocked checks passed 12 role/viewport entries and 18 keyboard layout choices against matching source/assets/API. All UI logins returned 200; logout returned 204 and closed private views. Four separate HTTPS sessions confirmed exact-token reuse was denied after logout; exact UI-bearer 401 was observed in three entries. The evidence register preserves storage and revocation scope limits. |
| Native | Six evaluated development/production configuration groups and JavaScript exports passed. Current Android Debug arm64 and unsigned x86_64 iOS Simulator compilations both passed for published source `7da2226a`; no installation or hardware result is claimed. |
| CI/image | Matching product tree `c77fb024` passed functional stages and runtime-image acceptance. Overall quality remains failed only by the existing dependency-enforcement gate. |

Published app/native/API source remains `7da2226a`; follow-up `a227a85` and later verification metadata affect harness, audit or documentation only.

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
