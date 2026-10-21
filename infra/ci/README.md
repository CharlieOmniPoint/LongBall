# Native compilation feasibility

`native-feasibility.yml` is a publication template for
`.github/workflows/native-feasibility.yml` on **`preview/longball-m0`** in the
public `CharlieOmniPoint/LongBall` repository. It is intentionally kept outside
`.github` in the development source. It does not provision services, use EAS,
access signing accounts, publish an app or change repository settings.

Automatic source publication compiles Android on standard `ubuntu-24.04` and iOS
on standard `macos-15`. A manual dispatch can select Android only, or include
iOS with `build_ios=true`.
Public standard runner minutes are free; larger runners are not used. Actions
artifact storage consumes the account's included storage quota, so uploads
default off. No billing settings or paid capacity are enabled by this workflow.
See [GitHub's billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Source transport and publication

Publish these files together on the preview branch, then publish the workflow:

| Path                               | Contents                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `preview/source.bundle.base64`     | Base64 of a Git bundle containing `refs/heads/dev/longball-m0-journey`, excluding the `origin/main` prerequisite history. |
| `preview/source.bundle.sha256`     | Exactly the lowercase SHA256 of the **decoded** bundle, followed by an optional newline.                                  |
| `preview/source-head.txt`          | Exactly the expected 40-character lowercase source commit SHA.                                                            |
| `preview/native-build-request.txt` | JSON object, normally `{"upload_artifacts":false}`. A revision/request identifier can be added as another field.          |

Each run checks out the preview transport commit with complete Git history and
read-only credentials. It clones that local repository into `source/`, verifies
the bundle's checksum and prerequisite objects, requires the bundled development
branch tip to match `source-head.txt`, and checks out that exact commit detached.
Malformed, missing, oversized or mismatched transport files stop the build.
The decoded bundle limit is 64 MiB; its encoded limit is 96 MiB. This proves
transport integrity against the checked-out metadata, not independent source
approval or a signed release provenance attestation.

The source bundle must contain committed source, the frozen pnpm lockfile and
the local native module. Generated `android/` and `ios/` directories and local
dependencies remain excluded; Expo prebuild regenerates them on the runner.
Updating the source metadata, bundle, request marker or published workflow
triggers both native compilation jobs. Runs on other branches, forks or a private copy
are refused. A newer run cancels an older run for the same branch.

## What the jobs build

Both jobs pin Node **24.19.0** and pnpm **11.25.0**, install the frozen lockfile,
and invoke the existing `expo prebuild --no-install` command. Expo runs without
login, telemetry or local dotenv loading. Native dependency downloads still
occur through the runner's normal network. The jobs check that SQLCipher is
requested, the local native bridge is declared and autolinked, and Android
backup is disabled in the generated manifest.

Android uses Temurin JDK **17**, Gradle **9.4.1** from the source wrapper, Android
SDK platforms **36 and 37.0**, build tools **36.0.0 and 37.0.0**, NDK
**27.1.12297006**, and CMake **3.22.1 and 3.30.5**. The runner bootstraps **Android command-line tools 23.0** (Android CLI 1.0.16625370) from the official `commandlinetools-linux-16111833_latest.zip` archive, checking its 181052239-byte length, official SHA1 `e025545c62a8e64c7559119566a569fb1dec5f60` and SHA256 `0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8`. It uses the new `android sdk install` flow and slash package paths; API 37 is `platforms/android-37.0`, not the nonexistent `platforms;android-37`. These cover the installed Expo 58 / React Native 0.88 application and native dependency configuration. The
debug build targets **arm64-v8a**, with two Gradle workers and a 4 GiB heap. Its
APK uses the generated debug key and has no release signing identity. It can
be installed on a compatible Android phone with `adb install -r <apk>`.

The iOS job explicitly selects **Xcode 26.3** on `macos-15`, installs
CocoaPods **1.17.0**, and builds the `LongBallSyntheticLab` Debug scheme for the
runner's iOS Simulator architecture. It disables signing and needs no Apple
developer account. The job fails if this Xcode is no longer installed rather
than silently selecting another toolchain. Its `.app` runs in a compatible
Simulator; it cannot be installed on a physical iPhone.

These are custom development clients. Start Metro from the matching source
with `pnpm dev`; an Android USB session can use `adb reverse tcp:8081 tcp:8081`.
The phone or Simulator must be able to reach that Metro server. These builds
are not independently distributed production apps.

## Standalone physical Android review

The separate [native-device.yml](native-device.yml) template runs only on
`preview/native-device`, with its own concurrency group. It builds a fictional
release variant with embedded JavaScript and the generated public debug key;
it does not need Metro or a real account. The original compilation workflow
above keeps its existing behaviour.

Exact source `c71f19d` passed the standalone build in
[run39608816471](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39608816471).
The retained [Android phone kit](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39608816471/artifacts/12350396424)
expires at **13:39:45 UTC on 22 October 2026**. Its downloaded ZIP, all eight
file checksums, embedded bundle, arm64 libraries and APK metadata were checked.
The APK requires Android API24 or later and `arm64-v8a`; its SHA256 is
`80fd8c78cdb389c332b0c7a899fc837b9c8fa687a28d90ab9cc3a2b34576bfc6`.
See the [phone installation and observation guide](../../docs/development/device-review.md)
and [exact artifact proof](../../docs/development/evidence/2026-10-21/feature-completion/android-device-kit.json).
No physical execution, native runtime encryption or clock/notification result
is inferred from these build and package checks.

## Unsigned iPhone device candidate

[native-ios-device.yml](native-ios-device.yml) runs separately on
`preview/native-ios-device`. It builds `iphoneos` ARM64 Release rather than a
Simulator application. [Run39611341666](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39611341666)
is in progress; no successful package or installation is claimed yet.

The candidate uses source `c71f19d` plus one recorded test configuration change:
`expo-notifications` has `enableRemoteNotifications:false`. This preserves local
reminders while omitting the APNs entitlement for a possible free personal
signing route. The proof records the exact one-file diff and before/after
configuration hashes. The main application's configuration and remote-push
scope remain unchanged. The workflow refuses signing credentials/profiles,
checks actual device-platform binary metadata and embedded JavaScript, and caps
the unsigned kit at 250MiB with one-day retention.

The unsigned IPA cannot install directly on an iPhone. Windows personal signing
is a conditional third-party route; computer availability, signing, renewal and
physical execution remain unproved. See the [device guide](../../docs/development/device-review.md).

## Logs, artifacts and review

The Actions run streams dependency, prebuild and compiler logs and records the
exact imported source SHA and bundle SHA256. Every platform also writes an
Actions summary stating the compile result and the limits of this evidence.
A successful compile is evidence of native compilation/linking for that
platform and source commit. It does not demonstrate runtime encryption or
physical phone behaviour.

To retain downloadable output, set the marker's `upload_artifacts` boolean to
`true`, or manually dispatch with `upload_artifacts=true`. Each requested
platform artifact contains source provenance, tool versions, up to the final
4 MiB of each build log, SHA256 checksums and the binary when compilation
succeeded. Artifacts are capped at **250 MiB per platform** with **one-day
retention**. Oversized output fails staging and is not uploaded. Review current
account storage usage before requesting multiple artifacts; this template does
not inspect account quotas or purchase storage. Without an upload request,
the binary remains on the ephemeral runner and is not retained after the run.

Device testing remains required for SQLCipher activation and wrong-key refusal,
SecureStore key loss/recovery and concurrent startup, atomic journal durability,
iOS/Android backup exclusion (including SQLite sidecars), clock continuity
through sleep/process death/reboot, notification scheduling/cancellation and
delivery, permission flows, camera/photo access, and supported physical phone
performance. Simulator compilation does not close these M0 gates or resolve
store privacy/required-reason API review.

The local managed environment previously stopped Android compilation at its
network-policy boundary when an official React Native Maven download redirected
to `repo.reactnative.dev`. This template runs on an independent standard GitHub
runner using that runner's normal network. No local proxy, trust policy or
allowlist is changed. A workflow existing in the repository is not itself a
successful build; inspect its actual run result before reporting compilation.

Action versions are pinned to verified upstream tag commits:

| Action                    | Tag    | Commit                                     |
| ------------------------- | ------ | ------------------------------------------ |
| `actions/checkout`        | v4.3.1 | `34e114876b0b11c390a56381ad16ebd13914f8d5` |
| `actions/setup-node`      | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/setup-java`      | v4.7.1 | `c5195efecf7bdfc987ee8bae7a71cb8b11521c00` |
| `actions/upload-artifact` | v4.6.2 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

Runner images and SDK download catalogs still evolve. Tool versions and the
exact source proof are logged so a later failure or result can be assessed.
