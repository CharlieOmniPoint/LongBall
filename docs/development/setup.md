# Synthetic M0 development setup

The initial journey and M0 adapter experiments are now implemented with fictional data. Use the [current review guide](review.md) for the application, browser commands and test evidence, and [Android build evidence](android-build-evidence.md) for the newer successful SDK36 installation and remaining artifact-host denial. The detailed preparation record below retains the original tooling observations; it is not a claim of current physical-device proof. Read the [architecture review](architecture-review.md) and [canonical pack](../longball/LongBall_Mobile_Build_Pack_v0_1.md) first.

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

`pnpm check` runs lint, both TypeScript checks, six fixture-import boundary tests, artifact/checksum/full OpenAPI validation, fixture generation and Android/iOS JavaScript bundle exports. The exported bundles are build inputs, not signed native apps. The six supplied fairness examples are checked by the archive validator; no match solver is implemented yet. All 15 archive members remain byte-for-byte preserved under `docs/longball`, including its original validation evidence.

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

The cloud server binds localhost, which may resolve to IPv6. Use `localhost` for the request. A future attached Android phone can use `adb reverse tcp:8081 tcp:8081` once a native development build is installed. No user-facing cloud preview is configured.

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

The attempted native build also requires Android platform 36 and build-tools 36.0.0 for Expo library modules. These additional downloads are currently blocked by a `503` upstream connection failure from the environment proxy to `dl.google.com`. The SDK setup now includes them and will retry the missing components. APK assembly has not passed.

An official alternate host, `dl-ssl.google.com`, currently receives a network-policy `403`. Its addition has been saved in the environment draft. After that setting is saved and applied, try:

```bash
python scripts/setup-android36-fallback.py https://dl-ssl.google.com/android/repository/
pnpm setup:android
```

The fallback verifies archive hashes and sizes against cached official Google metadata plus pinned checksums, and preserves existing SDK directories. Its syntax was checked; download and extraction remain unverified until network access permits them. It does not disable TLS or integrity checks.

`pnpm setup:android` repeats the cloud SDK installation from official Google metadata, verifying the command-line archive's published checksum and size. It also installs the exact JDK 17 package locally, verifying Microsoft's pinned signing-key fingerprint, signed repository metadata and SHA256 checksums. The new Android command-line tool uses `android sdk install`; it replaces the old `sdkmanager` flow. Ordinary SDK licences are accepted during installation. On other development machines, use Android Studio or a compatible SDK and set `ANDROID_HOME` yourself. `scripts/dev-env.sh` preserves an existing Android SDK choice.

Java does not automatically use the environment's HTTP proxy. `scripts/configure-gradle.py` registers the local JDK 17 and derives non-secret Java proxy host/port settings into ignored `.local/gradle/gradle.properties`, preserving existing differing settings. It retains TLS verification and limits Gradle to two workers and a 4 GiB heap. Proxy credentials are never copied into that file.

The prepared cloud machine has `/home/agent/.android` linked to `/workspace/longball-setup/android-home` because the newest adb still writes that home path. The SDK setup creates the link only when no configuration exists. If another cloud machine's filesystem requires permission for that operation, rerun it through the execution environment's supported permission flow. Existing Android configuration is preserved. Do not change `HOME`.

Generate projects from the Expo config without dependency installation:

```bash
source scripts/dev-env.sh
CI=1 EXPO_OFFLINE=1 pnpm --filter mobile prebuild
```

The generated Android configuration enables `expo.sqlite.useSQLCipher=true`, disables Android application backup and includes SecureStore backup exclusions. These settings were inspected; encryption activation and database/WAL/key backup behaviour still require implementation and physical-device tests. iOS database backup exclusions also remain implementation work. Native changes require rebuilding the custom client.

After the missing SDK components download successfully, resume the native debug build with the same target and resource limits used during setup:

```bash
cd /workspace/LongBall
source scripts/dev-env.sh
pnpm setup:android
CI=1 EXPO_OFFLINE=1 pnpm --filter mobile prebuild --platform android
cd apps/mobile/android
./gradlew :app:assembleDebug --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a --no-daemon
```

The attempt reached compilation of the React Native/Expo Gradle plugins and module discovery before failing to obtain build-tools 36.0.0. It did not produce a verified APK. The proxy settings solved Java's initial DNS failure, and the local JDK 17 solved the missing Java toolchain error.

Local iOS compilation requires macOS and compatible Xcode/CocoaPods, which are unavailable on this Linux machine. Installed React Native sources declare Xcode >=16.1 and CocoaPods >=1.10.1; these are lower bounds, not a verified Mac toolchain. The generated Expo deployment minimum is iOS 16.4; the proposed iOS 17+/Android 12+ LongBall pilot policy is still subject to the phone survey. Select and pin an actual working Mac/Xcode/CocoaPods combination when iOS experiments begin. No EAS CLI, paid build service, store account or production signing is needed for the checks above.

## Scope of checks

The initial checks establish tooling and fixture/contract integrity. Integration, access-control, database migration and native end-to-end suites do not exist yet, so no empty scripts claim that they pass. PostgreSQL, Fastify, worker jobs, Keycloak and media services will be added when their milestones need them. No hosted services have been provisioned.

Expo Doctor's first run passed 18 of 20 checks. Its online Expo schema and React Native Directory checks were blocked by network access; they are separate from the successful local configuration, package compatibility and bundle checks. `expo install --check` can compare against bundled metadata using `EXPO_OFFLINE=1`. Online diagnostics require `api.expo.dev`, `exp.host` and `reactnative.directory` in the environment network settings.

The current dependency and licence inventories were generated into ignored `.local/dependency-inventory.json` and `.local/dependency-licenses.json`. Refresh them with `pnpm list --depth Infinity --json` and `pnpm licenses list --json` when dependencies change. They are tool reports, not application assurance evidence.

M0 remains open until the clock, atomic encrypted event/outbox, key-loss/recovery, backup and notification experiments have real physical iPhone and Android results. See the [pending evidence table](architecture-review.md#m0-evidence-still-to-collect). Paid hosting and production credentials remain outside this stage.
