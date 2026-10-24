# LongBall M0 native experiment

Local Expo module, discovered from `apps/mobile/modules` when the development client is rebuilt. `requireOptionalNativeModule('LongBallNative')` exposes synchronous `readClock()` and `storageDirectory()` functions.

- `readClock()` returns `{ monotonicMs, continuityId, source, verifiedContinuous }`. Android uses `elapsedRealtime()` (including deep sleep) and `BOOT_COUNT`. iOS uses `mach_continuous_time()` and the boot-session UUID. If the operating system denies the reboot marker, continuity is unverified. A saved reading can only recover time when its nonempty continuity ID matches the new reading on the same installation/device and monotonic time has not moved backwards. Wall-clock subtraction is never a fallback.
- `storageDirectory()` returns `{ directory, backupExcluded, existingJournal }`. Android uses `noBackupFilesDir/longball`. iOS marks the Application Support `LongBall` directory as excluded from backup and reads the configured flag back. The database and its WAL/SHM/rollback journal belong inside that directory. `existingJournal` detects `longball-m0.db` or its companions so a lost key cannot silently create a replacement.

These are implementation candidates, not physical-device evidence. Native compilation, marker availability, sleep/lock, process relaunch, reboot, wall-clock changes, encryption, backup/restore and device transfer must be exercised on the supported iPhone and Android phones. A configured exclusion flag is not a completed backup test. Do not use Expo Go or a JavaScript bundle export as evidence of native activation.

Before App Store submission, review Apple's current required-reason API/privacy-manifest requirements for system boot time and the permitted handling of derived clock evidence. No reason code or permission to transmit a boot-session identifier is established by this experiment. Keep this synthetic M0 experiment local while that review is open.
