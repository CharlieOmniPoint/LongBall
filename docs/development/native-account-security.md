# Native account security and device review

SEC05 now offers the enrolled OS biometric or device passcode through the pinned
Expo SDK 58 `expo-local-authentication` 58.0.2 adapter. Android requests Class 3
biometrics and allows the OS device-credential fallback. The iOS Face ID usage
description is declared by the Expo config plugin. The local four-digit PIN
remains available as a separate optional mechanism. The port follows the [official Expo SDK 58 LocalAuthentication API](https://docs.expo.dev/versions/v58.0.0/sdk/local-authentication/).

The OS result can unlock only an existing unexpired SecureStore-backed session.
The client captures the local authority generation at public entry, before any
queued work or storage read, and binds the current session before prompting.
It rechecks both, expiry and the retained PIN record after each asynchronous
storage read as well as after OS success. Lock,
sign-out, replacement, expiry, cancellation and PIN lockout keep the session
closed. PIN cooldown and failure counts are not cleared. OS authentication
cannot refresh a bearer token, grant a role, create adult verification, alter the
SQLCipher key or renew provider authentication. Web never invokes the native
adapter and has no durable local PIN/device enrollment.

The account page lists only app registrations actually known to the service.
Native sign-in/resume submits an account-and-issuer-scoped installation identifier
from SecureStore; failure does not block sign-in or pretend registration succeeded.
Every role can refresh or retry its own enrollment. The service stamps registration
and last-seen times. Platform is explicitly client-reported, not independently
verified. Historical match-recorder registrations retain unknown platform/times.
These are not a complete IdP-session inventory or a count of physical phones;
remote revocation and recovery authority have not been invented.

## Physical-device checks still required

Use the custom native development build, not Expo Go. Configure a trusted,
reachable HTTPS issuer/API and exact registered native callback. On both iPhone
and Android:

1. Sign in using the system browser and a real PKCE return, then lock locally.
2. Exercise enrolled biometric success, device-passcode fallback, cancellation,
   changed enrollment and unavailable device authentication.
3. Leave the app or sign out while the OS prompt is open. A late success must not
   reopen the replaced/closed session. Test expiry while prompting.
4. Retain a failed-PIN cooldown and five-failure lockout; OS authentication must
   not clear or bypass either. Complete a fresh strong sign-in where required.
5. Check the same account installation ID survives app restart; a different
   account/issuer has a different metadata ID. Confirm the API's own-device list
   shows actual server times and other accounts remain inaccessible.
6. Confirm credentials remain protected by native secure storage, the existing
   journal key is unchanged and journal backup/encryption probes still pass.

Unit tests cover the native port contract and session races. Restricted PostgreSQL
and provider HTTP experiments cover service boundaries. Neither substitutes for
these physical-device checks.
