# M0 implementation scope and native evidence

20 October 2026. This is an intermediate synthetic implementation of [LongBall](../longball/README.md), retaining native iPhone and Android targets and the complete F01–F28 integrated pilot. It is not an M0 completion or release approval. See [decisions](decisions.md) and [capability traceability](traceability.md).

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
| Fairness | Preserve actual history and individual 90–110% bands. Mathematical targets and tested examples are not a full slot-level planner or a guarantee of future fairness. | D04/D05/D24, ME20–ME44, MT06–MT13 |

All data is fictional. The original boards use fictional sample names; implementation may use Player 01–13 to keep synthetic provenance explicit. White surfaces, green actions, restrained yellow warnings, platform system fonts, readable score/time and labelled actions preserve the approved visual direction. Screen-reader, outdoor and large-text physical testing remain required.

## Browser review alongside native

The browser review build is an additional surface requested for phone review and later link sharing. Reuse business rules and UI where practical. Keep browser persistence and any simulated clock/alert behaviour labelled accurately. Browser storage can be cleared/evicted; a browser tab/reload does not prove native continuous-clock recovery, SQLCipher, SecureStore, backup exclusion or OS notification behaviour. No deployment or external sharing is required to prepare the local review output.

The browser must not present a remotely synchronised score or account security that has not been implemented. The first increment has no production identity, server controller grant, accepted shared event stream, spectator permissions, ballots or photo publishing service. Those remain in scope for later milestones.

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
| D25 / MT17 | Complete synthetic two-half match in airplane mode, kill/reopen, reconnect and reconcile. | Durable local history, accepted server replay once, truthful sync status, unresolved conflicts preserved. Server portions await implementation. |
| QL07 / QL11 | Compact phones, 200% text, VoiceOver/TalkBack, reduced motion, outdoor glare/wet-hand/one-handed use and battery rehearsal. | Physical usability findings and battery/brightness/network conditions. |

Linux cannot compile/test iOS. No connected physical phones or signing identity are assumed. The prepared Android tooling must still produce a successful native binary, and that binary must be installed on actual target phones. Emulators supplement evidence; they do not establish notification, battery, biometrics or backup/device-transfer behaviour.

## Later milestones retained

M1 adds verified identity, memberships, team/season/profile/formations/fixtures and atomic offline download. M2 completes goals, substitutions, availability, planner, controller authority, accepted sync, corrections/recovery and manager report. M3 adds own records, training, season reports and historical corrections. M4 adds spectator grants, private ballots, deadlines and moderated photos. M5 and M6 add controlled beta and club release after policy, operating, restore, account and device gates. No milestone completion is inferred from a screen being visible.
