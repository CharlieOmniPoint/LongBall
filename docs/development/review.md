# Review LongBall

21 October 2026. Development branch: `dev/longball-m0-journey`; draft [PR1](https://github.com/CharlieOmniPoint/LongBall/pull/1). The full implementation is accepted for fictional review and preserves native iPhone/Android. Pages currently serves `d08666f`; the accepted discovery-reliability follow-up `e899e29` is ready for final publication. Current native CI passed Android debug and unsigned iOS Simulator Debug for source `d08666f`; no device execution is implied. Real-data and physical-device gates remain separate.

## Open the shared review

Share [LongBall on GitHub Pages](https://charlieomnipoint.github.io/LongBall/). Current published source `d08666f02aa1a229ee66b031cd2e238c7c263cfa` contains the full functional build. [External 390px entry proof](evidence/2026-10-21/full-publication/entry.json) passed at 19:45:19 UTC for exact build information, Welcome, Sign in and four fictional role choices, without anonymous recording storage, page errors or overflow.

Choose **Explore fictional Roma U10**, then Manager, Administrator, Player or Spectator. Fresh service identity/membership checks determine each context. The [current fictional API](https://conditional-runner-belief-delivery.trycloudflare.com/) passed health/build/CORS checks; its session is bounded from 19:48:46 UTC on 21 October to 00:48:46 UTC on 22 October. Its discovery status has refreshed and the current published review works. Accepted fix `e899e29` adds a bounded discovery cache key before the next publication; fresh public proof of that publication remains pending. Pages survives API expiry; renewal creates a fresh fictional database.

All accounts, players, matches and images are fictional. Do not enter real child data. The public review has no configured real operating identity provider. Sign in/Activate expose the consumer flow; the isolated Keycloak trial supplies provider proof, not production onboarding approval.

Manager can create a fixture, save preparation/snapshots, explicitly claim recording, check actual attendance, stage a complete lineup, confirm kickoff/pause and upload. A local save is separate from an accepted receipt; replies are separate from attendance. Other roles retain their own scope and sharing-policy limits. Four matchday groups include one negative preflight/refresh regression. Native timing and encrypted storage require physical-device proof.

## Latest accepted verification

| Verification | Result / scope |
| --- | --- |
| Shared/API/static | [686 shared/platform tests in 74 files; full lint/root/mobile TypeScript/contracts/boundaries passed. All five backend MJS artifacts match the quiet 284/45, zero-skip API run](evidence/2026-10-21/review-discovery-followup.json). |
| Connected browser | [18 groups](evidence/2026-10-21/discovery-functional-review/README.md) passed against `e899e29` in one unchanged complete rerun at 320/390px. The accepted run had zero runtime errors; an earlier unreproduced reset and separate diagnostic remain explicit. This is not a first-run/no-retry claim. |
| Production/native JS | [Six anonymous-entry checks, six configuration groups and both fresh production Hermes exports](evidence/2026-10-21/final-native-review/README.md) passed; each native artifact has its own measured hash. |
| Restricted runtime | [Both schema15 operational/restore proofs](evidence/2026-10-21/runtime/schema15-operational/summary.json) passed for unchanged backend/schema inputs: 37RLS tables, 30composite scope foreign keys and exact private media/encrypted registration/audit preservation. No new production image was exercised; the assessed 20–35 minute build with 2.3GB free remains a future deployment gate. |
| Published/native builds | [Current Pages entry](evidence/2026-10-21/full-publication/entry.json) passed for `d08666f`. [Native compilation](evidence/2026-10-21/full-publication/native-initial.json) passed Android debug and unsigned iOS Simulator Debug for source `d08666f`. Neither proves signing, installation or hardware. Current compile conclusions and the final cache-fix publication remain separate from physical execution. |

The [feature register](full-build-plan.md#verified-full-scope-implementation) records the implementation and source-bound proof. Earlier diagnostics retain their actual uncertainty; overlapping targeted counts and the diagnostic role run are not added to the totals.

## Historical checkpoints

Source `f4fbffe` previously passed public loaded-role and accepted matchday checks, with 576 shared/platform and 220 API tests. Its [entry evidence](evidence/2026-10-21/entry-journey/checkpoint.json) and [public matchday](evidence/2026-10-21/entry-journey/public-matchday.json) retain that retired source/session. The [7ede functional checkpoint](evidence/2026-10-21/final-build-checks.json) records the earlier 678-unit/18-browser result separately. Earlier `c71f19d` native compilations and phone kits are historical.

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
