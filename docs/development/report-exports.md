# Protected CSV/PDF report jobs

The canonical API04 report workflow is implemented alongside the existing JSON/CSV
compatibility route. Reports now offers season results, a permitted match summary,
manager team participation/attendance and player own participation/attendance.
Prepare CSV or PDF, wait for the separate worker, then explicitly download the file.
Preparation never automatically saves or shares a file. Native sharing, cancellation,
local file persistence and OS prompts still require physical iPhone/Android testing.

`POST /v1/exports` returns202 with a durable queued job. Requests use the current
selected role, contract version and stable idempotency key. Optional quoted If-Match
checks the report revision the user reviewed; its absence captures the current
transaction state. Receipts are scoped to account, team, season and selected role.
`GET /v1/exports/{id}` reports queued/working/ready/failed/expired;
`GET /v1/exports/{id}/download` serves an authenticated attachment. A relative
`downloadPath` supplies no bearer token or public access.

A request captures the already filtered report and encrypts it with AES256GCM.
A separately credentialled worker receives only one expiring lease and encrypted
snapshot, renders outside the database transaction and atomically checks scope and
source again before publishing. Three attempts and bounded backoff handle transient
failures; stale leases cannot publish. PostgreSQL schema16 enforces immutable
requester/team/season/role/source/key ancestry. The worker cannot read raw report,
community, account, membership or match records using an export capability.

Every download checks the current identity binding, selected role, membership or
grant, source fingerprint, publication policy, original expiry, encryption key and
artifact integrity, then records an opaque scoped download audit. A changed report
requires a fresh export. Files are limited to five MiB and sent with private no-store
headers, exact byte length and an opaque UUID filename. Allowed browser origins can
read the attachment headers. Saved copies outside LongBall are recipient-controlled.

CSV escapes quotes and formula prefixes. PDF uses pinned pdf-lib/fontkit and an
embedded licensed DejaVu font, with pagination and a Unicode text mapping. Unknown
values remain “Not recorded”; policy-masked score/derived fields explicitly say
“Withheld by competition policy”. Unsupported font codepoints are disclosed as
Unicode codepoint labels rather than silently dropped. JSON remains on the existing
compatibility route; the canonical job formats are CSV/PDF.

Production exports require an explicitly mounted mode0600/0400 32-byte hexadecimal
key file and an explicit TTL of1000–86400000ms. Neither is invented at startup.
Without both, the API remains usable and new export requests return503. The optional
Compose operator setup is documented in [the runtime guide](../../infra/runtime/README.md).
The bounded cloud review uses a fresh per-session key and a one-hour test TTL.
These technical artifact bounds do not approve pending Q05/Q09/Q10 decisions.

Verification added:45 focused API tests across SQLite/restricted PostgreSQL,
four shared parser boundaries,23 included key-configuration boundaries, PDF reader
and independent Poppler Unicode checks, actual schema15→16 rollback/retry,
requester isolation, role receipts, source/revocation checks, retry/lease fencing,
actual expiry, encrypted at-rest bytes and a scoped download audit. The packaged
runtime image has its own real PDF generation/read probe. The paired restore
harness now preserves an actual encrypted ready report and verifies separate-key
recovery plus wrong-key denial and ciphertext clearing; each current-source run
must pass before claiming restore acceptance.
