# Physical phone review kit

This kit starts physical M0 evidence using **fictional Roma U10 data**. The
Android workflow builds its APK from exact source
`c71f19dcea05f76adb0f7b5a4e2afb621d49bd40`. Preparing a workflow or compiling an
APK does not mark a phone test as passed. Record what actually happens on each
named phone and OS version.

## Android: a standalone APK

The separate `infra/ci/native-device.yml` template is published only on
`preview/native-device` as `.github/workflows/native-device.yml`. Its push
trigger watches that workflow and `preview/device-build-request.txt`; it uses a
separate concurrency group and does not cancel the running cloud review or
native compilation workflow. It runs on standard public `ubuntu-24.04`, with
read-only repository permission, a 45-minute timeout and no EAS account or paid
service. The marker is exactly:

```json
{
  "sourceHead": "c71f19dcea05f76adb0f7b5a4e2afb621d49bd40",
  "fictionalOnly": true,
  "requestId": "android-physical-c71-v1"
}
```

Reuse the reviewed source transport files on that isolated branch:
`preview/source.bundle.base64`, `preview/source.bundle.sha256` and
`preview/source-head.txt`. The workflow verifies the decoded checksum, bundle
prerequisites, exact bundled development-branch tip and hard-pinned source
commit before installing frozen dependencies. It does not modify application
source or the existing feasibility/cloud workflows.

It uses the same Node 24.19.0, pnpm 11.25.0, Temurin JDK 17 and pinned Android
CLI 23/SDK 37/NDK toolchain as the compilation workflow. `assembleRelease` builds
only `arm64-v8a`. The generated project explicitly uses its **public Android
debug signing key** for this release variant: this is an installable test APK,
not an app-store release or private signing identity. `NODE_ENV=production`
selects the optimized release bundle while
`EXPO_PUBLIC_ENVIRONMENT=development` deliberately selects the fictional app
journey. Dotenv loading is disabled. No API, issuer, bearer, test vault or real
account is supplied.

The workflow checks the embedded `assets/index.android.bundle`, generated
SQLCipher/backup/module configuration, APK signature, application ID and actual
minimum/target Android API levels. An embedded bundle means no Metro connection
is needed; cold launch in airplane mode must still be observed on the phone.
Official references: [Expo local release variants](https://docs.expo.dev/guides/local-app-development/#local-app-compilation)
and [React Native bundle variants](https://reactnative.dev/docs/react-native-gradle-plugin#debuggablevariants).
The installed React Native 0.88 Gradle-plugin source also creates bundle tasks
for non-debuggable variants. Version 0.88's dedicated documentation URL was
unavailable when checked; the actual frozen package and generated Gradle file
are the version-specific evidence.

### Download and install

The standalone Android build succeeded in
[run39608816471](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39608816471).
Download the verified
[fictional Android kit](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39608816471/artifacts/12350396424)
before **22 October 2026, 13:39:45 UTC**. Download requires GitHub access. Its APK
SHA256 is:

```text
80fd8c78cdb389c332b0c7a899fc837b9c8fa687a28d90ab9cc3a2b34576bfc6
```

This artifact reports **minimum Android API 24**, target API 36 and `arm64-v8a`.
The downloaded ZIP's eight file checksums were checked; the embedded bundle is
2,723,388 bytes. These package checks do not establish a physical installation
or any M0 runtime pass. Artifact name is
`longball-fictional-android-c71-arm64`; retention is **one day**. The kit is
capped at **250 MiB**, including bounded logs. It contains:

- `LongBall-fictional-c71-arm64.apk`;
- `build-proof.json`, with source/bundle/transport hashes, APK SHA256, ABI and
  actual minimum Android API;
- `SHA256SUMS`, signature/tool/build records and `START-HERE.txt`.

Extract the ZIP. On Linux use `sha256sum -c SHA256SUMS`; on Windows use
`Get-FileHash .\LongBall-fictional-c71-arm64.apk -Algorithm SHA256` and compare
the APK digest with the run summary and `build-proof.json`. A checksum records
which bytes were tested; the debug certificate is not a production trust claim.

On the Android phone, open the APK using Files or the downloading browser and
allow installation from that app when Android asks. The phone must support
`arm64-v8a` and meet `minSdk` in the proof. Open **LongBall Synthetic Lab**.
Alternatively, on a computer with Android platform tools and an authorized USB
connection:

```sh
adb devices
adb shell getprop ro.product.cpu.abilist
adb shell getprop ro.build.version.sdk
adb install -r LongBall-fictional-c71-arm64.apk
```

An existing installation may use a different certificate. If installation
reports a signature conflict, **stop and report it**; do not uninstall or clear
storage to make installation work. That would discard saved local records.
Likewise, preserve the APK/proof before the artifact expires. An expired
artifact can be rebuilt from the same pinned source; it is not a permanent public
download.

Enable airplane mode, turn Wi-Fi off, close the app and reopen it. The fictional
team home must appear without a development launcher, Metro prompt or network
service. Keep the entire first pass fictional: do not enter real player data,
configure a live API or assume the fictional role selector grants server access.

## First Android pass: about 15 minutes

Record the APK hash, phone model, Android version, start time, battery settings
and notification permission. Use a new fictional fixture so an earlier saved
match is not overwritten.

1. Open team home, check actual attendance for a fictional squad, prepare the
   seven-player lineup including an eligible keeper, and start the first half.
   Record the displayed save status. An RSVP is not match attendance.
2. Pause/resume, record one goal, make one explicit lineup change and inspect
   its history. Close/reopen after the UI says saved. Confirm the saved score,
   lineup and history survive with no duplicate effect.
3. Open **More → Native feasibility lab → Run journal encryption probe**. Record
   the displayed storage mode, cipher version and probe result. The disposable
   probe creates/reopens an encrypted file and attempts a wrong-key read; it
   does not delete or rekey the match journal. A failure or missing cipher is a
   failed gate, not permission to fall back to plaintext.
4. Leave a running half for two minutes: lock the screen, then return. Repeat
   by switching to another app and by closing/relaunching LongBall. Compare
   active time against a separately recorded stopwatch. Paused time must stay
   paused. Record actual behaviour, including any recovery prompt.
5. From the lab, use **Test notification in 10 seconds**, observe it with the
   screen open and locked, then test cancellation. Repeat after denying the OS
   permission. The app must remain usable and must not claim delivery occurred.
6. Reboot with a running fictional half. The new boot is a clock discontinuity:
   inspect the retained checkpoint and explicit recovery UI. Do not invent a
   recovered time or accept silent continuity across reboot. Keep the record
   and report the observed state before confirming any measured correction.

Reopen/force-stop observations cover real device persistence but do not inject
a crash at every transaction/acknowledgement boundary. Atomic failure injection,
key-loss and backup/transfer tests remain separately recorded work.

## Full clock, offline and alert rehearsal

Run a fresh fictional match as **two planned 25-minute halves** with manual
half endings and manual second-half start. Crossing zero must not automatically
end a half, start another half or move a player. Half-time and paused periods
do not count as active playing time. Keep the phone offline throughout local
capture; local save does not mean server sync or acceptance.

Use a separately observed reference and record readings before/after screen
lock, application switching, an interruption, wall-clock/timezone change and
process termination/relaunch **without reboot**. QL02's target is no more than
one second from the monotonic reference after 50 minutes. A hand-operated second
phone stopwatch is a useful comparison, but formal accuracy needs a known
reference and recorded start/read uncertainty. If that uncertainty exceeds the
target or is unknown, mark accuracy **inconclusive**, not passed. Do not alter
actual participation records to improve a timing or fairness result.

Exercise the planner's 90/60/30/0 warnings separately from the lab's ten-second
test. Confirm pause/replan cancellation, actual substitution only after human
confirmation, notification denial, silent/Focus settings, screen lock,
force-stop and battery restrictions. Record missed/delayed delivery honestly;
the OS does not guarantee a stopped-app beep. Screenshot the current warning
and explain the actual OS state rather than treating scheduled as delivered.

The standalone local journey has no server controller grant. Reconnection,
accepted replay, handover and conflicting-branch reconciliation require the
separate configured-service test. A local success does not close those gates.

## Separate configured-account pass

OS biometric/device authentication unlocks only a retained, current native
session; the fictional manager selector does not create one. Testing that path
needs an explicitly configured trusted HTTPS issuer/API, reachable from the
phone, exact native redirect registration and actual PKCE sign-in. `localhost`
on the phone is the phone itself, not the development computer. No reachable
service, trusted-CA installation, universal-link association, provider selection
or real onboarding is assumed by this kit.

Use the existing [native account-security checklist](native-account-security.md)
for success, cancellation, lock/sign-out/expiry during the prompt, PIN cooldown
and lockout, session replacement and truthful own-device enrollment. Do not
disable TLS verification, inject a vault or use real children to obtain proof.
Keep this pass separate from local clock/storage evidence.

## iPhone: verified unsigned kit and Windows signing

An iPhone is available and no Mac is available. A Mac is **not the only possible
installation route**: the official [AltStore Classic Windows guide](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
and [Sideloadly instructions/FAQ](https://sideloadly.io/faq) document Windows
tools that use the owner's free Apple Account to sign and install an IPA. These
are third-party personal-signing workflows, not Apple's Xcode installer and not
an observed LongBall installation. The owner has confirmed that a Windows PC is
available. Owner-local tool setup, signing and phone installation remain
untested, and no Apple credentials have been requested.

Use the [Windows installation guide](iphone-windows-install.md) with the
verified unsigned IPA below. It covers the owner-local
signing steps and stable-identity renewal.

The current unsigned **Simulator** `.app` still cannot run on iPhone hardware.
The verified device kit contains a cloud-compiled **iPhoneOS arm64 Release** app,
with embedded JavaScript, packaged as `Payload/LongBallSyntheticLab.app` in an
unencrypted IPA from this source. Owner-controlled signing must then occur on
their Windows computer; neither a raw unsigned IPA nor an APK can be installed
directly on iPhone. Expo Go cannot load this custom SQLCipher/native-clock
module and cannot prove M0. The separate iPhoneOS build is a preparation step;
successful local signing and device launch are not yet proved.

The separate [iPhoneOS template](../../infra/ci/native-ios-device.yml) targets
`preview/native-ios-device`, with marker `preview/ios-device-build-request.txt`
containing sourceHead `c71f19dcea05f76adb0f7b5a4e2afb621d49bd40`, fictionalOnly
`true` and requestId `ios-physical-c71-v4`. It uses the standard free `macos-15-intel` host with Xcode 26.3
and CocoaPods 1.17.0, checks the exact source and bundle hashes, and records the
allowlisted notification configuration's before/after hashes and one-file diff.
The successful run produced an **unsigned candidate**, bounded to 250 MiB
with one-day retention, without an Apple account, signing certificate or
provisioning profile.

[Run39616024656](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39616024656)
completed successfully, including iPhoneOS compilation, package checks and
artifact upload. Download the [verified iPhone kit](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39616024656/artifacts/12352708819) before
**14:39:52 UTC on 22 October 2026**. Its actual downloaded ZIP, all 11 checksums
and 12 files were independently verified;
[exact evidence](evidence/2026-10-21/feature-completion/ios-device-kit.json).

The signing input is `LongBall-fictional-c71-local-only-unsigned.ipa`
(10,280,863 bytes), SHA256 `3812c755233b58241669b634f4cf685794b6bb2176ac38a849fa971f6aa175fa`.
It requires **iOS16.4+** and contains device ARM64 Mach-O code and 3,329,065 bytes
of embedded JavaScript. The main app has no signature or provisioning profile;
it cannot be installed until the owner signs it locally.

The isolated transport commit is `100635dd137b959b48c79ecd04b121835de1e298`.
Its independently recreated single `app.json` change is the declared
local-notification-only configuration; this is not the unmodified production
entitlement configuration. The earlier
[preflight failure](evidence/2026-10-21/feature-completion/ios-device-preflight-diagnostic.json)
and [ARM64-host capacity incident](evidence/2026-10-21/feature-completion/ios-device-queue-diagnostic.json)
remain historical diagnostics. Local signing, installation and seven-day renewal
still require owner-observed results.

### Owner-controlled Windows prerequisites and limits

- Use a compatible Windows computer and USB cable. Sideloadly recommends
  Windows 10 or later. Both tools document the Apple **web versions** of iTunes
  and iCloud rather than the Microsoft Store versions. Replacing existing
  desktop software is a local owner action, not something performed here.
- Pair/unlock the iPhone, trust the computer, and use the owner's Apple Account
  locally in the selected tool. Complete any Apple two-factor challenge there.
  Do not send a password, verification code, signing certificate or provisioning
  profile to chat or CI. Sideloadly documents limited app-specific-password
  support for paid accounts, so that is not assumed for this free path.
- Enable Developer Mode on iOS 16 or later, including restart/confirmation,
  and trust the local developer profile when required. Follow
  [Apple's Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
- [Apple's free Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account)
  include seven-day provisioning profiles, up to three installed apps per device,
  ten App IDs and three registered devices with seven-day expiry. App extensions
  can consume additional App IDs. AltStore itself occupies an app slot.
- Refresh/re-sign before expiry using the same Apple Account and stable app
  identity. AltServer must be reachable from the phone for its refresh path;
  Sideloadly's refresh daemon also needs the computer and USB or configured
  Wi-Fi pairing. Offline play does not extend a signing profile's lifetime.
- Do not delete/deactivate the app, change its bundle ID or switch signing
  accounts to resolve a refresh problem. Signing/keychain identity changes can
  affect access to the independent journal key. Preserve records and report the
  failure; do not silently create a replacement encrypted journal.

For one IPA, Sideloadly offers a direct drag-and-drop Windows path without
installing the separate AltStore iPhone app. AltStore Classic provides an
alternative with its own app/AltServer refresh flow. This is a choice of local
tool and trust, not a reason to purchase an Apple membership. No jailbreak,
minimum-OS spoofing, tweak injection, certificate workaround or account sharing
is part of the proposed LongBall test.

### Entitlement and proof boundaries

The generated c71 iOS configuration currently requests
`aps-environment=development` because `expo-notifications` enables remote
notifications by default. Apple's [capability table](https://developer.apple.com/help/account/reference/supported-capabilities-ios)
lists push notifications and associated domains for paid memberships, not the
free Apple Developer account. It lists data protection and keychain sharing as
available for free accounts. These distinctions were checked against the
table's actual checkmark columns; an empty scraped Markdown table is not proof.

The verified **local-notification-only test variant** uses the officially
documented Expo SDK 58 option
[`enableRemoteNotifications:false`](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/#configuration)
to omit the APNs entitlement. The generated test configuration is recorded
in the IPA's provenance and independently verified; the signing instructions do
not ask the tool to strip arbitrary entitlements. It preserves local reminder scheduling;
it cannot prove APNs delivery, remote push or associated-domain universal links.
The production source and its complete feature scope stay unchanged.

| LongBall behaviour            | What this proposed free test can establish                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLCipher/custom native clock | These are compiled native code, not a paid Apple service. The actual iPhoneOS build/configuration checks passed; encryption, boot continuity and physical timing still need runtime tests. |
| SecureStore/own keychain      | The signed app must have valid app/keychain identity. Verify key retention through refresh/relaunch and fail-closed key loss; do not infer this from signing success.            |
| Face ID/device authentication | Requires supported/enrolled hardware, the declared Face ID usage description and a real retained session. No successful prompt or app-session integration is yet proved.         |
| Local notifications           | Can be tested in the explicitly local-only variant, subject to permission, Focus/lock and OS delivery limits.                                                                    |
| APNs/universal links          | Outside this free local-only variant; no remote-push or associated-domain proof is claimed. The configured custom-scheme PKCE return is a separate physical integration test.    |

The unsigned iPhoneOS IPA and source/configuration/binary checksums are now
verified. With the confirmed Windows PC, the next result is the owner’s observed
local signing/install and stable-identity renewal. The browser UI stays available during
these steps. No paid Apple/EAS service, account provisioning or
production provider choice has been made.

## Record results and remaining gates

Copy one row per observation; report failures before clearing or replacing any
saved local record. Record no bearer, invitation, provider proof or private key.

| Phone / OS / APK SHA | Scenario and exact steps          | Expected behaviour                                     | Observed result and timing | Evidence | Pass / fail / inconclusive / not run |
| -------------------- | --------------------------------- | ------------------------------------------------------ | -------------------------- | -------- | ------------------------------------ |
|                      | Airplane-mode cold launch         | Embedded fictional journey, no Metro                   |                            |          |                                      |
|                      | SQLCipher/wrong-key probe         | Nonempty cipher, correct-key reopen, wrong-key refusal |                            |          |                                      |
|                      | Saved event → process termination | Same durable effect/history once                       |                            |          |                                      |
|                      | Sleep/lock/kill without reboot    | Anchored active time or explicit uncertainty           |                            |          |                                      |
|                      | Reboot                            | Retained checkpoint and explicit recovery              |                            |          |                                      |
|                      | 50-minute run                     | QL02 target with recorded reference uncertainty        |                            |          |                                      |
|                      | Notifications/cancellation/denial | Observed platform limits, no automatic moves           |                            |          |                                      |
|                      | OS authentication                 | Configured-account checklist only                      |                            |          |                                      |

Keep [the native M0 register](implementation-scope.md#native-m0-proof-register)
open until each required experiment is actually evidenced on both platforms.
Independent key storage, lost/inaccessible key, journal/WAL/SHM backup and device
transfer exclusions, precise commit/acknowledgement failure injection, native
sharing/photo picker/cache, 200% text, TalkBack/VoiceOver, outdoor use and battery
rehearsal still require explicit observations. Several need an instrumented
disposable build; the ordinary release APK intentionally exposes no private
database/key inspector or reset switch.
