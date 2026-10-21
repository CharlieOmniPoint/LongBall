# LongBall worker

Run from the repository root against the API's explicit fictional SQLite database:

```bash
LONGBALL_SYNTHETIC_AUTH=1 node --import tsx apps/worker/src/main.ts --once
LONGBALL_SYNTHETIC_AUTH=1 node --import tsx apps/worker/src/main.ts
```

`LONGBALL_API_DATABASE` selects that database. The real runtime uses `LONGBALL_DATABASE_URL[_FILE]` with a restricted worker role and verify-only production schema startup. A dedicated operator migrator applies schemas first. Continuous mode polls every five seconds without overlapping cycles. It provisions no service and uses no Redis.

An award job is created only after an explicit cutoff is configured for trusted full-time evidence. The worker never silently accepts Q15's +59-minute proposal. It preserves full-time +60 as the separate deadline and marks late finalisation. Latest valid private ballots can produce joint winners; sealed awards are idempotent. Service audits use `actorAccountId:null` and `origin:'award_worker'`.

Jobs have unique business keys, durable leases, bounded retry/backoff and retained failures. Award projection, notification enqueue and job completion commit together; expired leases can be reclaimed after process failure. Actual PostgreSQL uses pinned transactions, `FOR UPDATE SKIP LOCKED` and lease-attempt checks. Award and notification job kinds are selected separately.

Generic notifications contain opaque scope/entity IDs only. Before dispatch, the worker reloads current account, membership, spectator grants, preferences, London quiet hours and entity policy. Provider I/O never holds the database transaction. An absent provider is durably `blocked_provider`; provider acceptance requires an actual receipt and is never labelled device delivery. Unknown outcomes without provider idempotency require review. Fourteen queue integration scenarios run on actual SQLite/PostgreSQL with explicit provider test doubles; no remote device push is claimed.

Production timing/load, monitoring, remote APNs/FCM delivery, approved retention/deletion and disaster-recovery operating policies still need deployment evidence or user decisions. These checks do not replace native device tests or M0 sign-off.
