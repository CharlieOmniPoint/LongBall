# Production configuration and entry verification

Production-config Android and iOS Hermes exports succeeded at source `b25a74f03b6f27d07871f0bb86fd6a5f9e202e5f`, after the bounded pinned public-review status cache-key fix. Six anonymous browser checks and six evaluated configuration check groups passed again.

The tested mobile, shared application/domain/testing packages, dependency manifest/lockfile and verification scripts have identical Git objects at integrated fix `e899e29f71ac50de7de4c7737ee4eb907d7e7823`. [verification.json](verification.json) records these object IDs, commands, export timestamps and measured artifact hashes. Other code differences between the isolated checkout and integrated source are API/media changes and an operational proof harness; they are listed separately. The cache-key fix changes shared review-entry code and its tests/harnesses, with native configuration and modules unchanged.

| Export | Bytes | SHA-256 |
| --- | ---: | --- |
| Android Hermes | 3,737,064 | `f050586425dfefcb53fa060c8ac7649f52e789a408c838f6be6a9473293b076c` |
| iOS Hermes | 3,722,891 | `a1d44d4c40fa926163ea65a48f56926a34759b216fe40bb90fd423c4e6591fd1` |
| Production web JavaScript | 1,482,804 | `dc82f9b9899e96e6eefd18d7654da0d476c8b8f22639f440c24b29c3e5c06e87` |

Both native files have Hermes magic `c61fbc03c103191f`. These exports used `NODE_ENV=production` and `EXPO_PUBLIC_ENVIRONMENT=production`, with public provider/API defaults and the fictional identity trial absent.

## What was checked

- [Anonymous browser report](anonymous-browser-report.json): 390 × 844 Welcome and sign-in journey; no fictional review entry, seeded persona, recording IndexedDB, overflow or page error. Provider settings remain collapsed. No authentication was attempted. [Welcome screenshot](anonymous-welcome.png) · [Sign-in screenshot](anonymous-sign-in.png).
- [Configuration checks](configuration-checks.json): actual Expo introspection of production and development profiles; production iOS ATS/Android cleartext policy, removal of Expo discovery/generated schemes, development-menu defaults, APNs environment, retained SQLCipher/backup/biometric/local-module settings and explicit local-only notification options. The profile comparison uses the explicit `/LongBall` web base path.
- [Allowlisted native fields](evaluated-native-fields.json): the production export's root-mounted configuration. App identifiers and the existing “LongBall Synthetic Lab” display name were preserved; these remain operator configuration choices.

The previous configuration-source ESLint and root/mobile TypeScript results are retained in the historical evidence. This refresh reran exports, configuration checks and anonymous browser checks; global static/shared tests are recorded separately by the integrating branch.

## Evidence limits

These are JavaScript exports and evaluated build configuration. They do not prove native compilation, signing, installation, OS permissions, physical clock/storage/biometric behaviour or notification delivery. Production APNs mode is a configuration value; no signing profile, notification provider or paid service was provisioned. Physical testing remains deferred.

[Previous configuration/export evidence at de2ae0a](historical-de2ae0a/README.md) is preserved intact, including its measured hashes, screenshots and references to [the initial source 55465b](historical-55465b.json). All current web/native hashes differ from both previous exports. Filenames are not used as proof of binary identity.

The initial 55465b permissive introspected ATS dictionary came from Expo's fallback template with no local iOS project present, and was not a measured compiled Release defect. The subsequent conditional configuration makes the production policy explicit while preserving development/trial behaviour.

This directory intentionally contains no raw configuration/build logs, provider defaults, credentials or distributable binaries.
