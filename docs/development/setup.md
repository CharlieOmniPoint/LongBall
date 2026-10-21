# LongBall development setup

Source `c71f19d` implements the fictional native/browser journeys and connected services. It passed 450 shared/platform tests and 219 API/access/worker tests with no skips, and both Android debug and unsigned iOS Simulator compilation. Use the [current review guide](review.md), [native CI configuration](../../infra/ci/README.md) and [physical phone kit](device-review.md). The earlier [local Android build record](android-build-evidence.md) preserves historical SDK/proxy failures; it is not the current native-build result. All physical-device behaviour remains unproved. The [canonical pack](../longball/LongBall_Mobile_Build_Pack_v0_1.md) remains unchanged.

## Pinned tools

| Tool | Version |
| --- | --- |
| Node LTS | 24.19.0 (`.node-version`, `.nvmrc`, `engines`) |
| pnpm | 11.25.0 (`packageManager`) |
| TypeScript | 6.0.3 |
| Expo SDK | 58.0.16 |
| React / React Native | 19.3.0 / 0.88.0 |
| Dev client / SQLite / SecureStore / notifications | 58.0.14 / 58.0.13 / 58.0.2 / 58.1.5 |
| ESLint / Expo lint config | 9.39.5 / 58.0.4 |
| Vitest / tsx | 5.0.5 / 4.23.15 |
| Python | 3.12.14 in the prepared cloud machine; dependencies frozen in `requirements-dev.txt` |

Expo's stable npm package, `bundledNativeModules.json` and blank TypeScript template were checked before selecting these versions. TypeScript 7 and ESLint 10 were not selected because Expo's current lint dependencies require older compatible majors. `pnpm-lock.yaml` records transitive versions and package integrity. pnpm's dependency build permissions explicitly allow only esbuild and unrs-resolver.

## Install and check

Use the existing checkout; a cloud task is already isolated, so no Git worktree is needed unless explicitly requested.

```bash
cd /workspace/LongBall
# Activate Node 24.19.0 with your usual version manager if needed.
bash scripts/setup.sh
source scripts/dev-env.sh
pnpm check
```

Setup uses a frozen pnpm lockfile, creates `.venv`, installs the pinned Python validators, seeds ignored `.local/fixtures/roma.json`, and validates the preserved archive contents. If the exact pnpm executable is absent it installs it under `.local/tooling`, without a global install. `scripts/dev-env.sh` selects writable local caches; source it in new cloud terminals. No `.env` or credentials are required.

`pnpm check` runs lint, root/mobile TypeScript, shared/platform and API/access/worker tests, archive/checksum/full canonical and runtime OpenAPI validation, strict logo/identity contract cases, publication-boundary checks, fictional fixtures and native JavaScript/API exports. The latest 450/219 test totals identify the recorded checkpoint, not a fixed expected suite size. Actual PostgreSQL/provider/HEIC fixtures need their isolated configured test dependencies; do not treat skipped cases as acceptance. The budgeted planner and its validation/proof tests are implemented separately from the six supplied arithmetic vectors. All 15 archive members remain byte-for-byte preserved under `docs/longball`.

Generated dependencies, native projects, bundles and local reports are ignored. Setup preserves edited extracted documentation rather than silently re-extracting it. To revise the original specification, keep source changes deliberate and update validation provenance separately; the archive checksum check is expected to flag differences.

## Start the mobile development server

```bash
cd /workspace/LongBall
pnpm dev
```

This runs Metro in offline mode on localhost for a custom development client. It does not require an Expo login, EAS project or hosted backend. The lab screen lists fictional players and selection status. Expo Go cannot exercise SQLCipher.

For an internal functional smoke check, request a bundle and inspect its content:

```bash
curl --noproxy '*' --fail \
  'http://localhost:8081/apps/mobile/index.bundle?platform=android&dev=true&minify=false' \
  -o .local/metro-android.bundle
rg 'LongBall Synthetic Lab|synthetic-player-13' .local/metro-android.bundle
```

The cloud server binds localhost, which may resolve to IPv6. Use `localhost` for the request. A future attached Android phone can use `adb reverse tcp:8081 tcp:8081` once a native development build is installed. This Metro address is local development tooling. The published Pages review and temporary cloud API are separate; see [review access](review.md).

## Native toolchain

The prepared Linux cloud machine runs Gradle on Java 21.0.12.1 and supplies Microsoft OpenJDK 17.0.20.1+1 for React Native's Java 17 compilation toolchain. The local Android SDK is at `/workspace/longball-setup/android-sdk`:

| Component | Version |
| --- | --- |
| Google command-line tools | 23.0 (archive 16111833) |
| Android platform | API 37.0, revision 2 |
| Build tools | 37.0.0 |
| Platform tools | 37.0.1 |
| NDK | 27.1.12297006 |
| Generated Gradle wrapper | 9.4.1 |
| Android Gradle Plugin / Kotlin | 9.2.1 / 2.2.0 |

The initial 20 October Linux attempt lacked SDK36 components and encountered upstream/proxy download failures. The [historical build record](android-build-evidence.md) preserves those observations. Later official SDK installation and standard-runner compilation succeeded; the current source's [run39605988033](https://github.com/CharlieOmniPoint/LongBall/actions/runs/39605988033) passed both native platforms. These old network failures are not current compilation gates. The separately requested standalone Android phone-kit workflow also succeeded and its arm64 APK artifact was downloaded/hash-verified; obtain it and verify the checksum through the device review guide before installation. No phone execution is implied.

`pnpm setup:android` repeats the cloud SDK installation from official Google metadata, verifying the command-line archive's published checksum and size. It also installs the exact JDK 17 package locally, verifying Microsoft's pinned signing-key fingerprint, signed repository metadata and SHA256 checksums. The new Android command-line tool uses `android sdk install`; it replaces the old `sdkmanager` flow. Ordinary SDK licences are accepted during installation. On other development machines, use Android Studio or a compatible SDK and set `ANDROID_HOME` yourself. `scripts/dev-env.sh` preserves an existing Android SDK choice.

Java does not automatically use the environment's HTTP proxy. `scripts/configure-gradle.py` registers the local JDK 17 and derives non-secret Java proxy host/port settings into ignored `.local/gradle/gradle.properties`, preserving existing differing settings. It retains TLS verification and limits Gradle to two workers and a 4 GiB heap. Proxy credentials are never copied into that file.

The prepared cloud machine has `/home/agent/.android` linked to `/workspace/longball-setup/android-home` because the newest adb still writes that home path. The SDK setup creates the link only when no configuration exists. If another cloud machine's filesystem requires permission for that operation, rerun it through the execution environment's supported permission flow. Existing Android configuration is preserved. Do not change `HOME`.

Generate projects from the Expo config without dependency installation:

```bash
source scripts/dev-env.sh
CI=1 EXPO_OFFLINE=1 pnpm --filter mobile prebuild
```

The generated Android configuration enables `expo.sqlite.useSQLCipher=true`, disables application backup and includes SecureStore exclusions. The native journal implements cipher-version and wrong-key probes, independent SecureStore keys, iOS backup-excluded database-directory verification and Android backup rules. Native compilation passed; actual on-phone encryption, database/WAL/key exclusions, restart and key-loss behaviour still require physical tests. Native changes require rebuilding the custom client.

For a local Android debug build, install the pinned SDK components and use the recorded resource limits:

```bash
cd /workspace/LongBall
source scripts/dev-env.sh
pnpm setup:android
CI=1 EXPO_OFFLINE=1 pnpm --filter mobile prebuild --platform android
cd apps/mobile/android
./gradlew :app:assembleDebug --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a --no-daemon
```

The original local attempt stopped before producing an APK; its proxy/JDK observations remain historical. Current native CI uses the exact frozen source and verified toolchain. iOS compilation runs on `macos-15` with Xcode26.3 and CocoaPods1.17.0, with signing disabled. This Linux workspace does not execute iOS. The proposed iOS17+/Android12+ pilot support policy still needs the phone survey; installed-tool minima do not settle device support. No EAS or paid build service is needed for those CI checks. Signed iPhone installation remains a separate unresolved route.

## Scope of checks

Integration, access-control, database migration, PostgreSQL RLS/worker, OIDC/provider and JPEG/PNG/HEIC media suites are implemented and exercised in isolated fictional environments. Schema12 runtime migration/startup and paired database/private-file restoration passed. Browser and native compilation evidence have their own exact-source limits; physical native end-to-end acceptance remains unrun. Free Pages/temporary runner review is published; no paid production service is provisioned.

Expo Doctor's first run passed 18 of 20 checks. Its online Expo schema and React Native Directory checks were blocked by network access; they are separate from the successful local configuration, package compatibility and bundle checks. `expo install --check` can compare against bundled metadata using `EXPO_OFFLINE=1`. Online diagnostics require `api.expo.dev`, `exp.host` and `reactnative.directory` in the environment network settings.

The current dependency and licence inventories were generated into ignored `.local/dependency-inventory.json` and `.local/dependency-licenses.json`. Refresh them with `pnpm list --depth Infinity --json` and `pnpm licenses list --json` when dependencies change. They are tool reports, not application assurance evidence.

M0 remains open until the clock, atomic encrypted event/outbox, key-loss/recovery, backup and notification experiments have real physical iPhone and Android results. See the [pending evidence table](architecture-review.md#m0-evidence-still-to-collect). Paid hosting and production credentials remain outside this stage.
