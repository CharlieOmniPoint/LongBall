# Connected identity client

This module implements configurable OpenID Connect authorization-code sign-in with PKCE S256 through Expo AuthSession and the system browser. It creates separate random state and nonce values, checks the configured issuer against discovery, validates the returned state and nonce/audience/time claims, then binds the account to the authenticated API's current `/v1/me` principal and memberships. Client-decoded ID-token claims never create an application role. The API verifies access-token signatures and current account authority.

Native credentials are held in a separate SecureStore service using `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; they do not enter the match journal. Browser credentials live in module memory only. Provider refresh rotates stored credentials after another `/v1/me` check. It never resets failed local PIN attempts. Local sign-out removes the connected credential while retaining the independent match database/key; provider revocation is reported separately when unsupported or unsuccessful.

Service and provider network waits run outside the credential queue. Local locking closes authority and notifies views immediately; a generation check prevents late API responses, refreshes, sign-ins or PIN attempts from reopening it. Sign-out clears the local credential before best-effort provider revocation. Provider operations have a 15-second deadline, and service fetches without a caller signal receive a 30-second abort signal.

The native callback is `longball://auth/callback`, requiring a new development build with the registered app scheme. Browser sign-in returns to the exact current same-origin page, normally `/`, so a static export can complete the popup. Discovery/PKCE is prepared before the explicit browser button to preserve the browser's user-gesture requirement. Public issuer/client/API/redirect configuration contains no client secret. HTTPS is required for issuer, token endpoints and the LongBall API.

The optional four-digit native PIN is a convenience lock for an already enrolled, unexpired session. Its salted verifier and durable attempts are separate from the random database key. Attempts are reserved in SecureStore before verification; a successful PIN does not clear earlier failures. Five failed attempts require a fresh strong sign-in and each failure applies a 30-second retry delay. A newly issued password-only session cannot bypass that retained lockout, and a changed session identifier never auto-unlocks an existing PIN after process launch. These are explicitly labelled experimental SEC05 defaults pending pilot acceptance. A PIN never creates, refreshes or extends a remote session. An unlocked session may separately ask its provider to refresh; the API checks the resulting credential again.

Activation and household recovery remain dependent on Q05's verification authority and an operational identity service. No provider, user account, recovery approval or paid service is provisioned by this module. The fictional Roma role selector remains a separate review surface and is not identity.

## Evidence and remaining proofs

- Core tests cover the RFC7636 S256 vector, discovery issuer/HTTPS, state expiry/mismatch, nonce/audience/authorized-party checks, API-only adult authority, changed refresh subjects, session/membership expiry, PIN scope, durable attempt transitions and clock rollback.
- Browser vault tests verify that access/refresh credentials are not written to localStorage, IndexedDB or the synthetic journal.
- Client tests use deferred network/provider promises to verify immediate lock and session-summary access during a stalled request, rejection of late refresh/response/PIN completions, and local credential deletion before remote revocation completes. SDK and vault adapters are mocked; these do not replace physical-device tests.
- Actual provider sign-in/refresh/revocation, public-client redirect registration, native SecureStore token size/backup handling, biometric/device changes, PIN crash interruption and process-relaunch checks require configured infrastructure and physical iPhone/Android testing. They have not passed merely because the TypeScript checks pass.
- Remote idle/absolute session policy, activation/recovery verification and operating account ownership remain unresolved product/operating decisions. This client follows provider-issued expiry and does not invent a service retention or session-duration policy.

SDK58 dependencies: expo-auth-session 58.0.13, expo-web-browser 58.0.6, expo-crypto 58.0.7 and expo-secure-store 58.0.2. Exact installed SDK types were checked against current official references:

- [Expo AuthSession](https://docs.expo.dev/versions/latest/sdk/auth-session/)
- [Expo WebBrowser](https://docs.expo.dev/versions/latest/sdk/webbrowser/)
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)
