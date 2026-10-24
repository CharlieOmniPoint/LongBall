# 24 October public account verification

Product `e2bf5a6744fbcdebd832d2d4e8795641d9d4488d`, tree `dc02bb704d522a1916573bccc09312a7755a7176`. The owner explicitly approved Firecrawl receiving the four existing dummy demo credentials for this live test. Credential values are absent from these records. The application source, native targets, approved visuals and feature scope are unchanged.

All eight role/width combinations passed against the actual public application: Manager, Administrator, Player/household and Spectator at both 320px and 390px. Each completed real login 200, the permitted workspace, logout 204, private-view closure and an empty password field after sign-out. No horizontal overflow or browser page errors occurred. Local storage, session storage and IndexedDB inspections found no known usernames/passwords, known HTTPS session tokens or opaque demo-session token pattern. Manager Team shows thirteen active editable players; Administrator configuration shows the separate Roma/U10 fields; Player past completed fixtures are read-only; Spectator sees the permitted match centre.

Four separate real HTTPS account sessions verified the current Roma team/season/role, permitted data and private preparation 404 for non-manager roles. Each session ended with DELETE 204, followed by 401 when reusing that same HTTP-session token. The browser's own bearer-token body was not inspected: UI logout 204/private-view closure and the independent HTTP token-revocation checks are separate evidence. These are live requests without route mocking, response replacement or application-record mutations.

The live sample remains thirteen player profiles and four matches: two completed and two in preparation. The completed checks cover unique role/width combinations; exploratory/repeated attempts are not additional coverage totals.

| Evidence | Scope |
| --- | --- |
| [public-browser.json](public-browser.json) | Eight final role/width combinations, four separate HTTPS account sessions, data and browser-store checks. Source and compiled Pages digest were rechecked after the role journeys. |
| [publication.json](publication.json) | Owner approval, live Pages/API provenance, renewed service expiry, observed outcomes and exact limits. |
| [runtime.json](runtime.json) | Renewal-only transport `c8400d2db240770c5f93669322fe33b6ce0ffeb7`, unchanged product, ready marker and job steps. The workflow intentionally remains running while serving; whole-job completion is not claimed. |
| [secret-scan.json](secret-scan.json) | Source/evidence scan passed with zero unexpected findings and 38 exact reviewed false positives. Actual dummy usernames and passcodes were separately checked absent from every added proof and current review document. |
| [earlier-attempts.json](earlier-attempts.json) | Remote response-body capture failures and a corrected test expectation for separate team name/age-group fields. Those attempts are not successful journeys or application defects. The final checks use direct UI status observations and separate HTTPS sessions. |

[Open LongBall](https://charlieomnipoint.github.io/LongBall/?v=e2bf5a6). [The renewed API](https://secrets-proposals-cup-horse.trycloudflare.com/) began at 11:26:31 BST and expires at **16:26:31 BST on 24 October 2026** (`15:26:31 UTC`). It uses [runtime 40085713495](https://github.com/CharlieOmniPoint/LongBall/actions/runs/40085713495). Pages persists; the separate five-hour API session is temporary. Renewal resets disposable sample changes. Login details are unchanged.

The original [23 October publication record](../../2026-10-23/workflow-retention/publication.json) remains unchanged: its automatic approval rejection, zero authenticated-public count and expired endpoint are historical observations. This explicitly approved follow-up resolves that test-approval gate.

The earlier source-bound 784 shared/platform tests, 396 host API tests, 24 migrations, CI/image acceptance and both native compilations remain [23 October evidence](../../2026-10-23/workflow-retention/README.md); they were not rerun or relabelled today. Physical phones, SEC20/SEC21 privacy fulfilment, UI34 governed support/recovery, production operations/distribution and the known dependency finding remain open as previously recorded. No real child data or paid service was introduced.
