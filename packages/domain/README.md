# Shared M0 match domain

Pure TypeScript, without platform, storage, HTTP or timer dependencies. The Expo native app and browser review build can use this same reducer. `src/types.ts` defines the local experiment commands; they are deliberately **not** the remote OpenAPI event envelope or an authorisation mechanism. The journal adapter wraps commands with durable device sequence metadata. Backend translation, controller-grant validation and service replay remain later work.

`createMatch`, `reduceMatch` and `replayMatch` implement explicit attendance, availability and selected-squad boundaries; staged preparation/half-time lineups; strict complete-lineup validation; manual halves; pause/resume; goals by beneficiary; live confirmed lineups; and deterministic participation intervals. Starting commits the whole lineup at once. The second half retains its own planned duration. Clock zero never ends play. Actual position totals conserve actual playing time.

`readClock` derives active duration from an anchor and an injected monotonic sample. No tick counter or UTC subtraction determines play. Different session IDs or rollback require recovery at the last durable checkpoint. A referee-confirmed forward recovery also requires explicit confirmation that the last secure lineup and availability remained unchanged. Other historical corrections and unknown participation need later audited reconciliation. The JavaScript clock is not evidence of a continuous native sleep-inclusive source; physical-device validation remains required. The device full-time timestamp is explicitly marked `reviewRequired` and cannot establish award deadlines.

`calculateTargets` uses exact bigint rational arithmetic and individual ±10% bands. `currentTargets` uses actual observed active intervals; `projectedTargets` adds only nonnegative remaining planned play and labels its assumption in the caller. These are experiments in the proposed Q07 interval algorithm, not owner acceptance of the proposal. `proveFixedKeeperGridContradiction` supplies the narrow FV06 capacity certificate; a null result proves nothing about schedule feasibility. There is no general substitution/position solver, shared-keeper-role optimiser or automatic substitution.

The boundary tests exercise duplicate commands, lineup rejection, half-time staging, the 23:40/25:00 case, overtime, pauses, position swaps, injury vacancies, deterministic replay, fractional monotonic readings, wall-clock changes, uncertain restart and explicit recovery. All six supplied fairness-vector arithmetic cases are covered. The tests do not establish server access control, a complete planner or native-device behaviour.

From the repository root:

```bash
source scripts/dev-env.sh
pnpm exec vitest run packages/domain/src/match.test.ts
pnpm exec tsc --noEmit
```
