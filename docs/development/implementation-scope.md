# M0 implementation scope and native evidence

> Initial M0 journey and current physical proof register. Source `c71f19dcea05f76adb0f7b5a4e2afb621d49bd40` is published at the [fictional Pages review](https://charlieomnipoint.github.io/LongBall/). Its Android and unsigned iOS Simulator builds passed [native CI](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39605988033). The expanded implementation and exact evidence are tracked in [full-build-plan.md](full-build-plan.md) and [review.md](review.md). Every physical-device row below remains open.

Updated 21 October 2026. The initial journey below remains part of [LongBall](../longball/README.md), retaining native iPhone and Android targets and the complete F01–F28 integrated pilot. The current checkpoint passed 450 shared/platform tests and 219 API/access/worker tests with no skipped tests; these results do not complete physical M0 or approve release. See [decisions](decisions.md) and the historical [capability traceability](traceability.md).

## Initial journey and behavioural acceptance

| Surface | Required behaviour in this slice | Source |
| --- | --- | --- |
| Team home | Keep Richmond Rovers / Roma U10 / 2026/27 context visible. Show next fictional match and preparation/resume route. | UI04/WF01, D02/D16 |
| Attendance | Keep response, selection, actual Present/Absent/Not recorded and match availability distinct. A fictional Available response cannot silently mark a player present. | UI07/UI08/UI13, REP02, G04 |
| Preparation | Stage seven unique eligible starters, one eligible goalkeeper, and available bench players. Validate on Start. No playing or bench duration accrues while staging. | F09/F10, UI13, D05/D11/D14, ME10/ME13 |
| Pitch interaction | Flat green pitch, crisp markings, circular pieces and separate bench. Provide a tap/list route, meaningful labels and minimum 48-unit targets. | Approved boards 01/02, D09, UX-A02, QL07 |
| Clock | Use anchored active time, deliberate pause/resume and manual first-half end and second-half start. Zero shows added elapsed time and never ends play. Second planned half remains 25:00 after an early/late first half. | F11, D14/D23, ME10–ME12, MT03–MT05 |
| Half-time | Freeze participation/bench accrual. Stage changes and apply them together only on second-half start. Leaving the match screen is not a pause. | UI18/WF04, MT02, UX-A07 |
| Persistence | A save claim follows a committed local write. Preserve pending records; server sync cannot be claimed without server acknowledgement. On uncertain clock continuity, require review rather than guessed elapsed time. | ME12, ME50–ME51, QL01/QL02 |
| Fairness | Preserve actual history and individual 90–110% bands. The implemented budgeted slot-level planner validates suggestions and reports feasible/infeasible/indeterminate outcomes; it cannot guarantee future fairness. | D04/D05/D24, ME20–ME44, MT06–MT13 |

All data is fictional. The original boards use fictional sample names; implementation may use Player 01–13 to keep synthetic provenance explicit. White surfaces, green actions, restrained yellow warnings, platform system fonts, readable score/time and labelled actions preserve the approved visual direction. Screen-reader, outdoor and large-text physical testing remain required.

## Browser review alongside native

The phone-friendly browser review shares business rules and UI with the native application. The current source is published at the lasting Pages address; the separate temporary fictional API expires according to its recorded session. See [review access and exact publication evidence](review.md). Browser storage can be cleared/evicted; a browser tab/reload does not prove native continuous-clock recovery, SQLCipher, SecureStore, backup exclusion or OS notification behaviour.

The original local slice has since been extended with OIDC/PKCE, scoped memberships/controller grants, accepted event replay, spectator activation/grants, private ballots, reports and scanned photo/logo publication. These services have isolated API/provider/browser evidence. Pages remains a fictional review surface, and production hosting, operating approval and physical-device proof remain separate.

## Native M0 proof register

Every physical-device row is **not run** until the named phone, OS, build, connectivity, steps and observed result are recorded. Bundling JavaScript, generating native projects, static inspection or unit tests do not turn these rows into passes.

| Gate | Experiment required on both physical iPhone and Android | Evidence still required |
| --- | --- | --- |
| ME12 / MT17–MT18 / QL02 | Run anchored clock through sleep, lock, call, wall-clock/timezone change, process kill/relaunch and reboot. | Continuous native clock/boot evidence; full 50-minute error bound; explicit uncertainty/recovery after discontinuity. |
| PL10 | Enable SQLCipher; require nonempty `PRAGMA cipher_version`; create/reopen encrypted data; attempt wrong-key read. | Native custom development binary and observed refusal without plaintext fallback. Expo Go is unsuitable. |
| PL10 / SEC05 | Retain independent random database key in SecureStore; exercise lost/inaccessible key and migration. | Key survives supported restart; no PIN-derived key; existing unsynchronised journal is never replaced or discarded. |
| PL10 | Inspect and exercise backup/device-transfer exclusions. | Database, journal/WAL/SHM and secure key exclusions on each OS, including iOS filesystem resource values and Android rules. |
| ME50–ME51 / DS11 / QL01 | Interrupt event, sequence, materialised-view and outbox writes before/after transaction and acknowledgement; retry. | No claimed saved event lost, no duplicate effect, per-match/device sequence retained across epochs, rejected branch preserved. |
| ME60 / PL04–PL05 / MT21–MT22 | Current-plan 90/60/30/0 visual/audio/local-notification alerts; pause/replan cancellation; deny permission; lock/Focus/silent/force-stop/battery restrictions. | Actual platform outcomes and limits; no automatic substitution or guaranteed stopped-app beep claim. |
| D25 / MT17 | Complete synthetic two-half match in airplane mode, kill/reopen, reconnect and reconcile. | Server replay, idempotency, epoch fencing and retained offline suffixes are implemented and HTTP-tested. The actual phone journey must still demonstrate durable history, once-only replay, truthful sync status and preserved conflicts. |
| QL07 / QL11 | Compact phones, 200% text, VoiceOver/TalkBack, reduced motion, outdoor glare/wet-hand/one-handed use and battery rehearsal. | Physical usability findings and battery/brightness/network conditions. |

The Linux workspace does not execute iOS. Separate macOS/Xcode CI compiled the unsigned iOS Simulator app, and Android debug compilation passed for the same `c71f19d` source. The [standalone Android phone-kit run39608816471](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39608816471) completed successfully and its [arm64 APK artifact](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39608816471/artifacts/12350396424) was downloaded and verified. It expires at 13:39:45 UTC on 22 October 2026; checksum/install instructions are in the device guide. No installation or phone behaviour is implied. The [unsigned iPhoneOS kit](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39616024656/artifacts/12352708819) also compiled and its actual download, checksums, device ARM64/iOS16.4+ metadata and recorded local-notification-only override were verified; [proof](evidence/2026-10-21/feature-completion/ios-device-kit.json). It expires at 14:39:52 UTC on 22 October. The [Windows guide](iphone-windows-install.md) provides the owner-local signing/install steps and seven-day renewal. No owner signing, installation or physical phone execution is recorded. The main application’s full scope is unchanged, and this test variant proves no remote push. See the [device review guide](device-review.md). Compilation and emulators do not establish notification, battery, biometric or backup/device-transfer behaviour.

## Milestone mapping and remaining acceptance

The connected implementation now includes the M1–M4 feature groups: identity/memberships and preparation; match events, planner, controller/replay and audited correction; own/training/season/history reports; spectator grants, private ballots/deadlines and moderated media. Their exact tested limits are recorded in the current feature register. M5/M6 controlled beta and club release still require policy, operating, restore, account and physical-device acceptance. No milestone completion is inferred from a visible screen or successful compilation.
