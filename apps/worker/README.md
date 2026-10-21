# LongBall development worker

Run from the repository root against the API's local SQLite database:

```bash
node --import tsx apps/worker/src/main.ts --once
node --import tsx apps/worker/src/main.ts
```

`LONGBALL_API_DATABASE` selects the database. Continuous mode polls every five seconds. It provisions no service and uses no Redis.

An award job is created only after an explicit cutoff is configured for trusted full-time evidence. The worker never silently accepts Q15's +59-minute proposal. It preserves full-time +60 as the separate deadline and marks late finalisation. Latest valid private ballots can produce joint winners; sealed awards are idempotent. Service audits use `actorAccountId:null` and `origin:'award_worker'`.

Jobs have unique business keys, durable leases, bounded retry/backoff and retained failures. Award projection and job completion commit together; expired leases can be reclaimed after process failure.

This is SQLite development infrastructure. PostgreSQL concurrency, monitoring/restore, email/push, media jobs, export and retention workers require further implementation and operating decisions. These tests do not establish production timing, device notifications or M0 completion.
