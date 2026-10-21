# LongBall worker

Run from the repository root against the API's explicit fictional SQLite database:

```bash
LONGBALL_SYNTHETIC_AUTH=1 node --import tsx apps/worker/src/main.ts --once
LONGBALL_SYNTHETIC_AUTH=1 node --import tsx apps/worker/src/main.ts
```

`LONGBALL_API_DATABASE` selects that database. The real runtime uses `LONGBALL_DATABASE_URL[_FILE]` with a restricted worker role and verify-only production schema startup. A dedicated operator migrator applies schemas first. Continuous mode polls every five seconds without overlapping cycles. It provisions no service and uses no Redis.

An award job is created only after an explicit cutoff is configured for trusted full-time evidence. The worker never silently accepts Q15's +59-minute proposal. It preserves full-time +60 as the separate deadline and marks late finalisation. Latest valid private ballots can produce joint winners; sealed awards are idempotent. Service audits use `actorAccountId:null` and `origin:'award_worker'`.

Jobs have unique business keys, durable leases, bounded retry/backoff and retained failures. Award projection, notification enqueue and job completion commit together; expired leases can be reclaimed after process failure. Actual PostgreSQL uses a protected claim function with `FOR UPDATE SKIP LOCKED`, followed by transaction-local context bound to the stored job, ancestry and a hashed lease capability. Ambient worker queries expose no private rows. Startup rejects owner/bypass credentials and mismatched runtime purpose. An award worker finalises only its claimed match, and a narrowly validated function enqueues its generic notification fanout. Award and notification job kinds are selected separately.

The PostgreSQL clock decides which work is due and when a lease expires; a future worker observation cannot bring a job forward. Award sealing, deadline evaluation and retry scheduling use fresh database time. Logical job context advances from the database-issued lease using elapsed monotonic time rather than a caller-selected wall clock.

Generic notifications contain opaque scope/entity IDs only. Before dispatch, the worker reloads current account, membership, spectator grants, preferences, London quiet hours and entity policy under its exact job scope. Provider I/O never holds the database transaction. An absent provider is durably `blocked_provider`; provider acceptance requires an actual receipt and is never labelled device delivery. Unknown outcomes without provider idempotency require review. Queue integration scenarios run on actual SQLite/PostgreSQL, including restricted worker roles, with explicit provider test doubles; no remote device push is claimed.

`scripts/runtime-worker.ts` is an explicit disposable-fixture proof. It requires a separately operator-preseeded, unsealed fictional match whose original trusted full time is already past its +60 deadline, and separate restricted API/worker selectors. It never seeds with serving credentials or advances the real server clock to manufacture deadline evidence.

Production timing/load, monitoring, remote APNs/FCM delivery, approved retention/deletion and disaster-recovery operating policies still need deployment evidence or user decisions. These checks do not replace native device tests or M0 sign-off.
