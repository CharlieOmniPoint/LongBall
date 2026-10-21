# Review LongBall

21 October 2026. Development branch: `dev/longball-m0-journey`; draft [PR1](https://github.com/CharlieOmniPoint/LongBall/pull/1). Development checkpoint `bb509f7` retains native iPhone/Android and the companion phone-browser demo. The [original-specification recheck](specification-recheck.md) supersedes the earlier blanket completion assessment. Privacy fulfilment and the operator support/recovery console remain incomplete.

## Open the shared review

The lasting address is [LongBall on GitHub Pages](https://charlieomnipoint.github.io/LongBall/). **The public build is still the older `c538419` checkpoint; the new development source has not yet been published and externally verified.** Choose **Explore Roma U10 demo → a role → Open connected demo** when that updated entry is available. The [functional walkthrough](functional-review-walkthrough.md) covers the intended journeys; the older public build may have earlier labels or controls.

The demo uses a generated named squad, simulated opponents, fixtures and training, and sample artwork. Connected changes are shared for a disposable service session. Keep real child data out of this review. A permanent Pages address does not make its separate API permanent. Renewal creates a fresh sample database; preserve an active feedback session until its recorded expiry.

The last recorded older service ran from 20:24:02 UTC on 21 October to 01:24:02 UTC on 22 October. Its [source-bound loaded-role proof](evidence/2026-10-21/full-publication/final-connected-roles.json) records that session. This is historical readiness, not a new health check or a promise that the endpoint remains available. New publication will record its actual source, service and expiry here.

Availability responses remain separate from actual attendance. Recording requires explicit controller claim, attendance checks, a staged lineup and confirmed clock actions. Queued CSV/PDF reports require the separate worker and an explicit download. Each role retains current permission and competition-policy limits. The public demo has no configured real operating identity provider; isolated provider trials do not approve production onboarding.

## Source-bound verification

Current development includes later changes than the full `ee7cb613` verification. Do not apply earlier counts to a later source or add overlapping focused suites into a release total. Current-source evidence packaging and publication are pending.

| Source / check | Observed result and limit |
| --- | --- |
| `ee7cb613` aggregate | 741 shared/platform tests and 367 API tests passed with no API skips; 24 migration checks passed. Lint, root/mobile TypeScript and contract checks passed within that aggregate. |
| `ee7cb613` exports/configuration | Browser, production-web, native Hermes JavaScript and API/worker exports passed. Six native evaluated-configuration groups and six actual anonymous-entry browser groups passed. The isolated 390px entry had no runtime errors, overflow or anonymous recording IndexedDB. Configuration/export is not native compilation or hardware proof. |
| `ee7cb613` role/matchday browser | Eight role-entry groups and six matchday groups passed at both 320/390px. These are the observed journeys, not every UI/error state. |
| Root browser/application checks | Six local groups and application checks 01–08 passed. Application 09 timed out at entry with no established cause; the unchanged isolated 09 rerun passed. Two policy/handover and four accepted-view groups passed. The original timeout remains a failure record; this is not a clean first-attempt claim. |
| `bb509f7` focused changes | Readable PDF/actual SQLite/restricted-PostgreSQL HTTP checks 16/16, shared records-service checks 11/11 and notification checks 49/49 passed. TypeScript/scoped lint passed. These overlap other suites and do not replace a fresh full aggregate. The actual queued-PDF browser rerun is pending. |
| QL04 performance | Every recorded rehearsal has missed the 500ms p95 target. Latest `bb509f7`: read p95 1,186.690ms; command p95 2,035.796ms. A revised database-locking candidate awaits a new measurement; no passing target has been established. |
| Dependency quality | The gate fails on two high build-tool advisories. Keep exact advisory versions/paths and separate runtime-scan scope in quality evidence; do not call this check passed. |
| Publication/native compilation | New-source Pages/API publication and native CI results remain pending. Historical `c538419` public/native checks do not certify `bb509f7` or subsequent locking changes. |

## Remaining implementation and acceptance

The owner explicitly deferred **Q05/Q09/Q10** for later. Privacy export/deletion request capture and status exist; SEC20/SEC21 verified fulfilment, retention-aware deletion/anonymisation, downstream revocation and restore-time deletion-ledger enforcement remain incomplete. The UI34 operator support/recovery case console is also incomplete. No ordinary administrator receives automatic global child-record or credential access.

Physical iPhone/Android testing remains deferred. Preserve both targets and the [native M0 proof register](implementation-scope.md#native-m0-proof-register): encrypted restart/key loss/backup, sleep/kill/reboot timing, alerts/Focus/battery, OS authentication, picker/share/system browser and accessibility require device evidence. Do not regenerate expiring kits or re-ask for deferred phone tests during this feedback phase.

Real identity/private storage/push/monitoring/recovery, moderation/support ownership, signed distribution and the remaining timing/controller/audience policies stay open. Demo sharing settings do not approve real U10 audiences. Local load or paired restore cannot establish phone performance, monthly availability or offsite recovery objectives. No paid service or real child-data environment has been provisioned.

## Historical checkpoints

- `c538419`: [external 390px entry](evidence/2026-10-21/full-publication/final-entry.json) and [all four connected roles](evidence/2026-10-21/full-publication/final-connected-roles.json) passed at 20:21/20:28 UTC on 21 October. [Native CI](evidence/2026-10-21/full-publication/native-final.json) passed Android arm64 Debug and unsigned x86_64 iOS Simulator Debug. No installation or physical execution is proved.
- `e899e29`: [686 shared/platform checks and matching 284/45 API backend](evidence/2026-10-21/review-discovery-followup.json), [18 browser groups](evidence/2026-10-21/discovery-functional-review/README.md), and [production/native JavaScript/configuration checks](evidence/2026-10-21/final-native-review/README.md) retain their original source/artifact scope. Earlier reset/diagnostics remain disclosed.
- Schema 15: [operational/restore proofs](evidence/2026-10-21/runtime/schema15-operational/summary.json) retain unchanged historical backend/schema inputs. They do not certify schema 16, a later image or real offsite recovery.
- `f4fbffe`: [entry checkpoint](evidence/2026-10-21/entry-journey/checkpoint.json) and [public matchday](evidence/2026-10-21/entry-journey/public-matchday.json) retain their 576-unit/220-API scope. The [earlier 678-unit/18-browser checkpoint](evidence/2026-10-21/final-build-checks.json), `c71f19d` compilations and phone kits are also historical.

The [build register](full-build-plan.md#current-source-implementation-and-verification), [screen inventory](entry-completion-audit.md), [traceability](traceability.md) and [decisions](decisions.md) distinguish source, proof and remaining work. Historical artifacts are unchanged.

## Run in the development workspace

```bash
cd /workspace/LongBall
source scripts/dev-env.sh
pnpm check
pnpm build:web
pnpm build:api
LONGBALL_SYNTHETIC_AUTH=1 LONGBALL_STATIC_DIRECTORY="$PWD/apps/mobile/dist-web" pnpm dev:api
```

The combined server defaults to `http://127.0.0.1:4310` on that machine. Cloud localhost is not a sharing address. Queued CSV/PDF exports additionally need the separate worker with the same database, export key file and TTL; see [protected reports](report-exports.md) and [runtime setup](../../infra/runtime/README.md). `pnpm check` does not turn a separately failed dependency or performance gate green.

Runtime/identity reproduction is documented in [API](../../apps/api/README.md), [restricted PostgreSQL](../../infra/runtime/README.md) and [identity trial](../../infra/identity/README.md). Production entry requires connected identity and omits demo accounts. Historical [capability](evidence/2026-10-21/feature-completion/checkpoint.json) and [security](evidence/2026-10-21/security-checkpoint/checkpoint.json) evidence does not validate later source.
