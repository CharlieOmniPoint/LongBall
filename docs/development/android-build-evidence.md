# Android native build evidence

20 October 2026. Synthetic development only. Native compilation and device behaviour are separate checks.

## SDK preparation observed in this workspace

The prior setup note described blocked Android 36 downloads. During this implementation, both official Google download hosts returned HTTP 200 through the configured proxy. `scripts/setup-android36-fallback.py https://dl-ssl.google.com/android/repository/` verified the archived Google metadata, SHA-1 and byte lengths, then installed:

| Component | Official archive / checksum |
| --- | --- |
| Build tools 36.0.0 | `build-tools_r36_linux.zip`, SHA-1 `b0b6376977657e8ad9b969bacf4093601da2c6fb` |
| Android platform 36 revision 2 | `platform-36_r02.zip`, SHA-1 `2c1a80dd4d9f7d0e6dd336ec603d9b5c55a6f576` |

The old `build-tools/36.0.0` directory contained only a failed `.installer` workspace. It was preserved at `/workspace/longball-setup/incomplete-build-tools-36.0.0` before installation; no user source or installed binary was discarded. Installed `aapt2` and `android.jar` were confirmed present. SDK/Gradle caches and generated native projects remain untracked.

## Commands and result

From the repository:

```bash
source scripts/dev-env.sh
CI=1 EXPO_OFFLINE=1 pnpm --filter mobile prebuild --platform android
```

Prebuild **passed**. Generated configuration retained `expo.sqlite.useSQLCipher=true`, `android:allowBackup="false"`, SecureStore backup rules and autolinked `longball-native`.

Native compilation command:

```bash
source /workspace/LongBall/scripts/dev-env.sh
python /workspace/LongBall/scripts/configure-gradle.py
cd /workspace/LongBall/apps/mobile/android
./gradlew :app:assembleDebug --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a --no-daemon
```

First result: **failed** during task dependency calculation. `react-native-svg:compileDebugJavaWithJavac` selected `/usr/lib/jvm/java-21-openjdk-amd64`, whose host installation has a runtime but no Java compiler. The full Microsoft JDK 17 already installed by the repository setup is available. Retry selects that JDK explicitly:

```bash
JAVA_HOME=/workspace/longball-setup/jdk17/usr/lib/jvm/msopenjdk-17-amd64 \
  ./gradlew :app:assembleDebug --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a --no-daemon
```

Second result: **failed** while downloading `io.github.expo:expo-modules-v2-react:0.2.5` from Maven Central. The extracted JDK's stock trust store did not include the managed environment proxy CA, producing a certificate path error. The host Java trust store already includes that configured CA. A third attempt retains certificate verification and selects it explicitly:

```bash
JAVA_HOME=/workspace/longball-setup/jdk17/usr/lib/jvm/msopenjdk-17-amd64 \
  ./gradlew :app:assembleDebug --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a \
  -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts --no-daemon
```

Third result: **failed at a network-policy boundary** after 1 minute 25 seconds, with 71 tasks considered (39 executed, 32 up to date). SDK/JDK/trust configuration was accepted and native resource/codegen tasks ran. `expo-modules-core:compileDebugKotlin` could not resolve `com.facebook.react:react-android:0.88.0` because Maven Central redirects its debug AAR to:

```text
https://repo.reactnative.dev/maven2/com/facebook/react/react-android/0.88.0/react-android-0.88.0-debug.aar
```

The managed proxy returned HTTP 403 for that destination. An independent request to the same official destination confirmed `Tunnel connection failed: 403 Forbidden`. The hostname is absent from the applied environment network allowlist. Add `repo.reactnative.dev` through the supported environment network-settings workflow and apply the change, then rerun the third command. No available agent tool can change that configuration. Do not bypass the proxy or disable TLS.

**No APK was produced.** The custom Kotlin module has been discovered but has not yet been compiled. There is no observed custom-module source failure to report. Prebuild, module discovery, dependency downloads and JavaScript bundle export cannot be reported as a successful native build. The generated diagnostic report is `apps/mobile/android/build/reports/problems/problems-report.html` (ignored local output).

Observed build configuration: Node 24.19.0; pnpm 11.25.0; Gradle 9.4.1; Kotlin plugin 2.2.10 (catalog declared 2.2.0, plugin-selected value logged); build tools 37.0.0; compile SDK 37; target SDK 36; framework minimum SDK 24; NDK 27.1.12297006. The framework minimum does not approve the proposed LongBall Android 12+ support floor.

## Still outside this evidence

No physical Android phone run is established here. SQLCipher activation, wrong-key refusal, SecureStore key handling, clock continuity/reboot detection, backup/device-transfer exclusions, notifications, process kill/reopen and airplane-mode replay remain in the [native proof register](implementation-scope.md#native-m0-proof-register). iPhone compilation requires macOS/Xcode and its own signing/device setup; it is unrun on this Linux workspace. No paid service was provisioned.
