# Review LongBall

21 October 2026. Development branch: `dev/longball-m0-journey`; draft [PR1](https://github.com/CharlieOmniPoint/LongBall/pull/1). Native iPhone/Android and the complete agreed scope remain the target. The current public entry build is working; later full-scope work is implemented and verified, awaiting publication. See the [feature register](full-build-plan.md) for the difference between released behaviour, development source and release gates.

## Open the shared review

Share [LongBall on GitHub Pages](https://charlieomnipoint.github.io/LongBall/). Published source `f4fbffe99ae977d89172afb86f78bbf262b275e1` passed external 390px checks for Welcome, consumer sign-in and all four loaded connected roles. Choose **Explore fictional Roma U10**, then Manager, Administrator, Player or Spectator. The explicitly fictional route discovers a healthy review service; it carries no credential in the URL and grants no real-account role. Fresh service identity/membership checks determine each connected context.

The [current fictional API](https://prophet-hearing-processed-eugene.trycloudflare.com/) was ready at 17:28:28 UTC and expires at **22:28:28 UTC on 21 October 2026**. This five-hour session uses a disposable shared fictional database. Pages remains available afterwards; a healthy new API and its expiry must be verified before connected review resumes. Preserve test data during feedback rather than renewing a running session. A renewal changes the address and creates fresh data.

All Roma U10 accounts, players, matches and images are fictional. Do not enter real child data. The public review has no configured real operating identity provider. Normal **Sign in** and **Activate account** expose the consumer flow; the separately configured local Keycloak trial supplies actual provider proof, not production onboarding approval.

Review the role homes and ordinary navigation. Manager can create a fresh fixture, save preparation/snapshots, explicitly claim recording, check actual attendance, stage a complete lineup, confirm kickoff/pause and upload. A local save and an accepted service receipt are separate. Availability replies do not establish attendance. Spectator/Player views retain their own scope and sharing-policy limits.

The public matchday proof confirmed nine present players, seven starters and accepted revision12 / `first_half_paused` through a separate HTTP read. The local suite has **four matchday groups, including one negative unprepared-fixture/preflight-refresh regression**. Native timing and encrypted native storage require physical-device proof.

## What passed for the released entry source

| Check | Recorded result and scope |
| --- | --- |
| External review | [Publication](evidence/2026-10-21/entry-journey/publication.json), [loaded Player/Spectator views](evidence/2026-10-21/entry-journey/public-loaded-player-spectator.json) and [accepted public matchday](evidence/2026-10-21/entry-journey/public-matchday.json) passed on actual public HTTPS/CORS. Earlier loading snapshots are followed by the loaded-state proof. |
| Shared/API checks | 576 shared/platform tests in 59 files and 220 API tests in 31 files without skips; full lint, root/mobile TypeScript, canonical/runtime contracts and source-publication checks passed. [Checkpoint](evidence/2026-10-21/entry-journey/checkpoint.json). Earlier timeout diagnostics remain preserved. |
| Browser | 25 normal checks, four planner reload checks, eight local role entries, six anonymous production-entry checks and four connected matchday groups passed. [Aggregate](evidence/2026-10-21/entry-journey/controller-planner-review.json), [roles](evidence/2026-10-21/entry-journey/role-entry.json), [production](evidence/2026-10-21/entry-journey/production-entry.json), [matchday](evidence/2026-10-21/entry-journey/connected-matchday.json). Their source/artifact bindings remain separate. |
| Targeted composition | [Preparation](evidence/2026-10-21/entry-journey/preparation-presentation.json), [trusted provider entry](evidence/2026-10-21/entry-auth/spectator-entry-browser.json) and [vote/concern/hide UI](evidence/2026-10-21/community-ui-ed08/README.md) passed their recorded scopes. |
| Native | Both Hermes JavaScript exports passed and are hashed in the checkpoint. [Entry native CI](evidence/2026-10-21/entry-journey/native-ci.json) passed Android; the iOS hosted job never started and was cancelled because no runner was acquired. The next publication uses a standard Intel macOS runner. No entry-source iOS compilation or physical result is inferred. Earlier `c71f19d` Android/iOS compilation and phone kits remain historical evidence for that source. |

## New source not yet at the public link

Candidate `7ede8d1ef944823cfd6a5f6965ab51d4c37d286e` is implemented and accepted for fictional functional review; publication is pending. It includes contribution privileges, encrypted push registration, canonical policy changes, verified downloads, recurring training, CSV import, calendar download, reusable plans, own-player fixture details, match-history pages and accepted read-only Manager viewing. The public link still serves `f4fbffe`.

| Final verification | Result / scope |
| --- | --- |
| Shared/API/static | [678 shared/platform tests in 74 files with matching tested inputs; 284 API tests in 45 files, zero skips; lint, root/mobile TypeScript and contracts passed](evidence/2026-10-21/final-build-checks.json). |
| Browser | [18 fresh connected groups](evidence/2026-10-21/final-functional-review/README.md) passed first run at 320/390px, with exact web/API hashes checked before/after. |
| Production/native | [Six anonymous-entry checks, six configuration groups and both production Hermes exports](evidence/2026-10-21/final-native-review/README.md) passed. Native hashes are measured separately. This is not compilation/signing/physical evidence. |
| Runtime | [Both current schema15 operational/restore proofs](evidence/2026-10-21/runtime/schema15-operational/summary.json) passed: product `7ede8d1` / operational `5185f00`, 37RLS tables, 30composite scope foreign keys and exact private media/encrypted registration/audit preservation. A new production container was not exercised. |

The final summary preserves earlier diagnostics with their original source and uncertainty. They are not relabelled as passing runs. Publication/external verification is the next step.

Targeted proofs remain bound to their original artifacts: [SEC17](evidence/2026-10-21/sec17/README.md), [push registration](evidence/2026-10-21/push-registrations.json), [policy local](evidence/2026-10-21/policy/local-ui.json)/[connected](evidence/2026-10-21/policy/connected-ui.json), [recurrence](evidence/2026-10-21/training-series.json), [import/calendar](evidence/2026-10-21/import-export/README.md), [reusable plans](evidence/2026-10-21/reusable-match-plans/README.md), [accepted Manager viewing](evidence/2026-10-21/accepted-manager-view/README.md) and [verified downloads](evidence/2026-10-21/offline-bundle.json). These overlapping scoped counts are not a new global total. The [feature register](full-build-plan.md#unreleased-full-scope-closure) separates source integration from final release evidence.

## Remaining acceptance

The owner deferred phone installation/hardware tests for this browser-feedback phase. Preserve the native target and [M0 proof register](implementation-scope.md#native-m0-proof-register): SQLCipher/key-loss/backup, sleep/kill/reboot clock continuity, notification/Focus/battery behaviour, OS authentication, native picker/share/system browser and accessibility remain unproved. Historical kits and Windows signing guidance are linked in the [device guide](device-review.md); do not regenerate or request phone tests without a new need.

Production identity/private storage/push/monitoring/recovery, support/moderation/lifecycle ownership and the recorded recovery/privacy/timing/audience decisions remain open. A generic notification queue is not device delivery, privacy request capture is not fulfilment, and fictional sharing settings do not approve real U10 audiences. No paid service or real child-data environment has been provisioned.

## Run in the development workspace

```bash
cd /workspace/LongBall
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

The combined server defaults to `http://127.0.0.1:4310` on that machine. Cloud localhost is not a sharing address; use Pages for review. Runtime/identity reproduction is documented in [API](../../apps/api/README.md), [restricted PostgreSQL](../../infra/runtime/README.md) and [identity trial](../../infra/identity/README.md). Production exports require connected identity and omit fictional accounts. Older `c71f19d` and schema9 evidence remains under [historical capability evidence](evidence/2026-10-21/feature-completion/checkpoint.json) and [security evidence](evidence/2026-10-21/security-checkpoint/checkpoint.json); those hashes do not validate later source changes.
