# M0 platform boundary

The shared match reducer consumes clock samples and local commands. These adapters keep native APIs out of that reducer. The M0 local command payload is **not** the remote `MatchEvent` contract; no API acceptance, authority grant or synchronisation has been implemented.

## Native development build

`openJournal()` refuses activation without the local `LongBallNative` module, a verified backup-excluded directory, an accessible SecureStore key, and a nonempty SQLCipher version. Keys are 256 random bits, independent of any PIN. An existing journal with a missing key is retained and refused; it is never replaced with a plaintext or empty database.

The journal uses SQLCipher SQLite in Android `noBackupFilesDir/longball` or an iOS Application Support directory marked excluded from backup. Main database, WAL, SHM and rollback journal remain together. Keychain access is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; Android backup is disabled in the app configuration and SecureStore's plugin applies its own exclusions. These are implemented controls, **not physical backup/restore evidence**.

Each `commit` transaction stores the immutable local command, projection, per-match/device sequence and pending outbox record. The sequence continues across controller epochs. Same-ID/same-content retries return the existing result without restoring an old projection; different content conflicts. An expected local revision prevents a stale tab/handle from overwriting the saved projection. A stale candidate is retained with its candidate projection and reserved sequence as a quarantined branch; only after commit does the adapter throw `LocalConflictError`, allowing an explicit reload without deleting that branch. Rejected/quarantined rows remain available for later reconciliation. The M0 app has no server, so ordinary saved events remain pending and none are labelled synced.

Native transactions use queued `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` on the already keyed SQLCipher connection. Expo's `withExclusiveTransactionAsync` implementation opens a different connection without inheriting `PRAGMA key`, so it is deliberately not called. Exposed reads and close join the same queue; they cannot display a partially committed projection.

`Journal.runCipherProbe()` creates only a disposable synthetic file, writes a marker, reopens with the correct key, and verifies a different key cannot read it. It never rekeys, removes or resets `longball-m0.db`. A successful result applies to the running native build only. Phone test results have not yet been collected.

`readClock()` uses the native module's sleep-inclusive Android elapsed realtime or iOS continuous clock, with a same-boot marker. The absence of continuity evidence is explicit. A JS fallback invalidates its session on foreground return. Device sleep, process restart, reboot, wall-clock change and 50-minute timing accuracy remain physical-device gates.

`alerts.ts` provides explicit permission request, capability reporting and cancellation/replacement of owned 90/60/30/0 local reminders. It is a prepared M0 adapter and is not yet connected to a validated substitution plan. It does not guarantee sound in Focus/silent mode, after force-stop or under battery restrictions. Foreground visual/audio/haptic acceptance is incomplete.

## Browser review

The `.web.ts` variants reuse the same match logic and store one synthetic IndexedDB document. A read/write transaction serialises stale-source checks and event/projection writes across tabs, including phone LAN HTTP contexts. The interface acknowledges success only after transaction completion. An earlier localStorage review document migrates once without deleting the original. Browser data is unprotected, can be evicted or cleared, and is not a native journal or backup. Reload or return from a hidden tab changes clock continuity and requires explicit time checking during active play. Secure random IDs use WebCrypto's `getRandomValues` fallback where LAN HTTP does not offer `randomUUID`.

The browser cannot establish SQLCipher activation, SecureStore/key loss, database/WAL backup exclusions, native process/reboot continuity, local sound/haptics or lock/Focus delivery.

## Executed local verification

`vitest` exercises the adapter cores against real Node SQLite and a controllable browser-document write harness: transaction failure rollback, same-ID retries/conflicts, retained rejected branches and sequences across epochs/reopen, unsupported-schema refusal, quota failure, damaged-data preservation and stale-source quarantine. Real IndexedDB transaction behaviour is a separate browser check. Node SQLite is unencrypted and does not prove SQLCipher, native crash behaviour or filesystem durability.

Expo autolinking resolves `LongBallNative` on Android and Apple. TypeScript and lint checks pass for these adapters. Native compilation, iOS signing and physical-device rehearsals must be recorded separately from these local checks. Before store submission, review Apple's required-reason/privacy declarations for continuous uptime/boot evidence; no reason code has been invented here.
