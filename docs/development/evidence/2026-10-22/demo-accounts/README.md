# Demo account and Roma season verification

Product source: `214844e65310ccd4bb070b2f5a35395837fed19c`. Use the [verified versioned entry](https://charlieomnipoint.github.io/LongBall/?v=214844e) and Sign in. Credentials are supplied in the conversation and are excluded from this evidence, app screens and browser exports.

- [Verification](verification.json): 756 shared/platform tests, 394 API tests without skips, 24 migration checks, lint/types/contracts, packaging and flagged native JavaScript exports passed. Earlier test/harness diagnostics remain qualified.
- [Exact packaged phone journey](phone-browser.json): all four assigned logins/sign-outs at 320/390px passed, including wrong-password rejection and password-field clearing. This used the exact Pages JavaScript bytes against a real loopback API with test discovery routing.
- [Actual publication](publication.json): matching public Pages/API source and browser bytes, four real public sign-ins/sign-outs, current squad/fixtures/totals and session revocation were verified. The versioned entry avoids the older HTML retained by an already-cached tab.
- [Data checks](data-checks.json): named thirteen-player squad and four fixtures, with detailed canonical completed games and consistent participation. Historical and future data remain distinct.
- [Cloud checks](cloud-checks.json): source-equivalent CI passed 756 unit, 391 API plus three explicit decoder skips, 24 migrations and ten browser checks. The actual runtime-image job passed; quality failed solely at dependency enforcement. Android Debug compiled with the login flag; the recorded iOS job was still compiling. Binary upload was disabled and no physical-device or signed-distribution result is claimed.

The current connected API expires at **15:45:26 BST on 22 October 2026** (14:45:26 UTC). Pages and verifier configuration persist; the disposable API database and sessions do not. No paid service was provisioned.

The registry gate remains failed on two high build-tool advisories; the separate moderate finding is retained. Privacy/support decisions and physical tests remain deferred as recorded in the [review status](../../../review.md) and [account guide](../../../demo-accounts.md). This feature acceptance does not declare a production release.
