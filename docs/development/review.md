# Review the initial LongBall journey

20 October 2026. Development branch: `dev/longball-m0-journey`. The supplied pack is preserved under `docs/longball`; all F01–F28 remain in the [traceability register](traceability.md). This increment implements a local fictional manager journey and M0 experiments. Physical M0, the full manager pilot and the integrated pilot are not complete.

## Run and review

```bash
cd /workspace/LongBall
source scripts/dev-env.sh
# On a fresh machine: bash scripts/setup.sh
pnpm build:web
pnpm preview:web
```

Open `http://localhost:4173` on that machine. On a development machine accessible from a phone on the same network, use that machine's address and port. A remote cloud workspace's loopback is not a public review link; no hosting or forwarding has been provisioned. The [static packaging instructions](../../infra/browser-review.md) prepare a later HTTPS link without choosing a provider or incurring costs.

1. **Prepare match** opens actual check-in. Nine fictional players are selected, but nobody is inferred present from an availability reply. Mark players individually or explicitly check in the selected nine.
2. Continue to lineup, place the first seven, then tap a place or use List view to choose/swap players. Missing places and an ineligible goalkeeper cannot start the half.
3. Start the first half. Pause/resume deliberately; navigating back to the team leaves the clock running. Tap a pitch place to stage a live change, review it and confirm once.
4. End the half manually with confirmation. Change the second-half draft during the break; no playing or bench minutes accrue. Start a fresh planned 25-minute second half regardless of the actual first-half duration.
5. At zero, recording continues with added time and a visible warning. End manually. Reports shows the local actual participation record. This is not the complete REP01–REP07 service.
6. Reopen a running browser session to exercise **Time needs checking**. Supply referee active elapsed time and explicitly confirm that lineup/availability stayed unchanged. Otherwise retain the journal for later reconciliation; this slice cannot reconstruct an unknown history.

Browser records live in IndexedDB, per origin and browser. They are unprotected, independent fictional rehearsals and may be cleared/evicted. A failed write offers the exact same-ID retry. Another tab's stale write is retained in quarantine without replacing the current projection; explicitly reload the saved match to continue. No saved action is described as remotely synced.

For native development, `pnpm dev` starts Metro for a custom client. Rebuild native binaries after module/plugin changes. Expo Go cannot exercise SQLCipher. **More → Feasibility lab** exposes a disposable encryption/wrong-key probe and explicit notification permission/test/cancel controls. These have not been exercised on a phone.

## Executed checks

Environment: Linux cloud workspace, Node 24.19.0, pnpm 11.25.0, synthetic Roma fixture only; no phone or signing identity connected.

| Check | Observed result and limit |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed with the pinned lockfile. |
| `pnpm check` | Lint, root/mobile TypeScript, 38 tests across four files, fixture generation, preserved-pack checksums/full OpenAPI structural validation and Android/iOS JavaScript exports. These are separate from native compilation. |
| Domain tests | Manual halves/pauses/overtime, unchanged second duration, halftime staging, command idempotency, interval conservation, continuity refusal, reviewed clock correction and all six fairness arithmetic vectors. No complete planner or phone timing benchmark claimed. |
| Adapter tests | Ten cases using actual Node SQLite and the same keyed-connection queue boundary, transaction-failure rollback/retry, simultaneous writes, deduplication/conflicting IDs, sequences across epochs, rejected/stale branch retention, schema refusal, damaged/quota browser-document writes. Node SQLite is not SQLCipher/device durability evidence. |
| `pnpm build:web` | Passed; static export under `apps/mobile/dist-web`. HTTP smoke check returned 200. |
| `node scripts/browser-review.mjs` (`pnpm test:e2e`) | Passed ten checks in Chromium 154.0.8037.57 with a virtual clock. Main rehearsal: actual first half 23:40, no three-minute pause/seven-minute break accrual, fresh second 25:00, explicit reopen recovery, wall-clock rollback, +01:12 added time and manual 49:52 finish. All 21 main records are unique and ordered; recorded seven-place participation conserves time. Also passed real IndexedDB failed-write retry/quarantined-tab scenarios, 320/390/1440 layout checks and visible 48-unit primary controls. No browser runtime errors. This is accelerated automation, not a 50-minute physical rehearsal. |
| `pnpm dev` + Android Metro HTTP bundle request | Server started and returned a bundle containing the implemented synthetic fixture/journey. No custom client was installed. |
| Android prebuild/autolinking | Passed; SQLCipher configuration, backup settings and local native module are present in generated projects. |
| Android debug compilation | Blocked after SDK/JDK/trust-store repairs by an environment-policy HTTP 403 for the official React Native AAR host `repo.reactnative.dev`. No APK produced. See [exact attempts](android-build-evidence.md). |
| Dependency inventory/licences | Refreshed under ignored `.local/dependency-inventory.json` and `.local/dependency-licenses.json`. These are inventories, not a clean vulnerability attestation or complete release SBOM. |

The archived artifact checker prints its original `not_run` list; `scripts/validate-contracts.py` separately executes the full OpenAPI validator. Structural validation does not resolve [C-001](decisions.md#contract-issue-requiring-implementation-resolution) or establish running API behaviour.

Saved browser evidence: [results](evidence/2026-10-20/browser-results.json), [home](evidence/2026-10-20/home.png), [lineup](evidence/2026-10-20/lineup.png), [live controls](evidence/2026-10-20/live.png), [desktop](evidence/2026-10-20/desktop.png). Reruns write fresh reports/screenshots under `.local/review`. The browser suite needs a running review server and a Playwright Chromium installation; this workspace used `/usr/bin/chromium`. Else install the matching browser with `pnpm exec playwright install chromium`, or select `LONGBALL_CHROMIUM_PATH`.

## Incomplete and next eligible work

The [physical-device proof register](implementation-scope.md#native-m0-proof-register) remains open: SQLCipher activation/reopen/wrong-key refusal, independent key lifecycle/loss, database/WAL/key backup and transfer exclusions, sleep/lock/process kill/reboot continuity, actual notification/Focus/battery behaviour, 50-minute clock accuracy, outdoor accessibility and battery measurements. iOS compilation requires macOS/Xcode; Apple's required-reason declarations for native boot/uptime evidence also need review.

After the native artifact host is allowed in environment settings, rerun the documented Android build and install on a phone. Prepare a Mac/native iPhone build, then execute the M0 device matrix. The prepared 90/60/30/0 reminder adapter is not connected to a validated planner; full foreground sound/haptic acceptance is incomplete. The ten-second lab notification is a disposable experiment and never changes a lineup.

M1–M4 still need identity/permissions, editable team/season/profile/formations/fixtures/training, complete goal and availability workflows, deterministic substitution solving, accepted server event sync/controller handover, audited corrections, role-filtered reports/history, spectators, private awards and moderated media. API/access/native end-to-end/restore/release suites are unimplemented or unrun; no empty successful scripts stand in for them. Native/background requirements cannot be accepted through a browser result.

Q05–Q10, Q14–Q15, Q18, Q20 and Q21 remain as detailed in [decisions](decisions.md). In particular, the proposed +59-minute vote cutoff is not approved; confirmed award finalisation remains original full time +60 minutes. No infrastructure/store purchases, production credentials, real child data or public deployment were introduced.
