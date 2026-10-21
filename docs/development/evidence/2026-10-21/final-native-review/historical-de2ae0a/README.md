# Production configuration and entry verification

Production-config Android and iOS Hermes exports succeeded at source `de2ae0ab236c0b1fbfddfea48cc3fa1e7ccfe840`. Six anonymous browser checks and six evaluated configuration check groups passed. Scoped ESLint and both root/mobile TypeScript checks passed.

The tested mobile, shared application/domain/testing packages, dependency manifest/lockfile and verification scripts have identical Git objects at integrated configuration commit `ff0691c6be5449f74c3a2ef7c613b18cdf8ad82d` and API follow-up `7ede8d1ef944823cfd6a5f6965ab51d4c37d286e`. [verification.json](verification.json) records these object IDs, commands, export timestamps and measured artifact hashes. The integrated follow-up changes API/media code and its evidence only.

| Export | Bytes | SHA-256 |
| --- | ---: | --- |
| Android Hermes | 3,736,819 | `1b12bc15defa73b31f5d8cd06ce37e99988f2ab008a6c07005f17def91c5bf23` |
| iOS Hermes | 3,722,571 | `c9670e07c6e090e57ffcd41ffe77ac3164035c8a6f010d2dd23a21c6749997ec` |
| Production web JavaScript | 1,482,669 | `a101c20d436dc776dc9aac99bf90be653a1156aa9ad25caa81754fe8ff5aca23` |

Both native files have Hermes magic `c61fbc03c103191f`. These exports used `NODE_ENV=production` and `EXPO_PUBLIC_ENVIRONMENT=production`, with public provider/API defaults and the fictional identity trial absent.

## What was checked

- [Anonymous browser report](anonymous-browser-report.json): 390 × 844 Welcome and sign-in journey; no fictional review entry, seeded persona, recording IndexedDB, overflow or page error. Provider settings remain collapsed. No authentication was attempted. [Welcome screenshot](anonymous-welcome.png) · [Sign-in screenshot](anonymous-sign-in.png).
- [Configuration checks](configuration-checks.json): actual Expo introspection of production and development profiles; production iOS ATS/Android cleartext policy, removal of Expo discovery/generated schemes, development-menu defaults, APNs environment, retained SQLCipher/backup/biometric/local-module settings and explicit local-only notification options. The profile comparison uses the explicit `/LongBall` web base path.
- [Allowlisted native fields](evaluated-native-fields.json): the production export's root-mounted configuration. App identifiers and the existing “LongBall Synthetic Lab” display name were preserved; these remain operator configuration choices.

## Evidence limits

These are JavaScript exports and evaluated build configuration. They do not prove native compilation, signing, installation, OS permissions, physical clock/storage/biometric behaviour or notification delivery. Production APNs mode is a configuration value; no signing profile, notification provider or paid service was provisioned. Physical testing remains deferred.

[Historical source 55465b](historical-55465b.json) retains the original export hashes and browser result separately. Its Hermes filenames match the current filenames, but both measured native binary hashes differ; no binary identity is claimed. Its web JavaScript hash matches. Its permissive introspected ATS dictionary came from Expo's fallback template with no local iOS project present, and was not a measured compiled Release defect. The subsequent conditional configuration makes the production policy explicit while preserving development/trial behaviour.

This directory intentionally contains no raw configuration/build logs, provider defaults, credentials or distributable binaries.
