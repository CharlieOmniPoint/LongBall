# QL04 local performance evidence

The final unchanged workload passed the original **p95 below 500 ms** target locally on source `60789694c89dd4bc8aa5902ddb984dc84f6cba45`: **489.948 ms for 800 reads** and **483.195 ms for 200 commands**. This has a narrow margin. Individual maxima were **574.186 ms** and **600.531 ms**, so the result does not mean every request finished within 500 ms.

All five runs are retained below, including four target misses. The instrumented diagnostic is labelled separately. The [index](index.json) provides source fingerprints, checksums, host notes and limitations. Each original summary and source manifest is copied byte for byte.

| Run | Runtime source | Read p95 | Command p95 | Recorded result |
| --- | --- | ---: | ---: | --- |
| [Baseline](01-baseline-70ed8cf4-summary.json) | `70ed8cf4` | 1,265.717 ms | 2,177.951 ms | Target not met |
| [Own-account membership filter](02-own-membership-filter-ee7cb613-summary.json) | `ee7cb613` | 550.334 ms | 1,064.710 ms | Target not met |
| [Instrumented diagnostic](03-instrumented-diagnostic-ee7cb613-summary.json) | `ee7cb613` | 583.830 ms | 1,265.642 ms | Target not met; diagnostic overhead applies |
| [Scoped notification lookup and API batch insertion](04-scoped-notifications-bb509f71-summary.json) | `bb509f71` | 1,186.690 ms | 2,035.796 ms | Target not met |
| [Reviewed match management team locks](05-match-team-locks-60789694-summary.json) | `60789694` | 489.948 ms | 483.195 ms | Passed this bounded local p95 scope |

## Workload and boundaries

The [benchmark script](../../../../../../scripts/performance-review.mjs) was unchanged across all five runs, verified through its recorded SHA256. The 500 ms target, concurrency, sample count and workload were unchanged. Each run used ten isolated teams, ten unfinished live games, 13-player game rosters, ten manager accounts and 40 spectator accounts. Each of 20 measured cohorts issued 40 accepted-summary reads and ten canonical pause/resume commands concurrently. Fifty warmup requests were excluded from the measured latency distributions. The summaries include all 1,080 HTTP responses, including setup and warmup; every response was 200 and no command was rejected.

This exercised actual loopback HTTP and PostgreSQL through a separate non-owner, non-bypass API role with row-level security. Each game's controller, actual check-in, staged lineup and first-half start were accepted through the canonical HTTP routes before measurement. The schema-owner connection closed before HTTP work. Each run created and removed only its own random database, three roles and temporary media directory; existing data was preserved.

The samples measure client-observed loopback latency through JSON parsing, including local transit and a separately timed in-memory fixture session verifier. This is not pure server instrumentation or a measurement of OIDC login, JWT signatures, JWKS retrieval or an external identity provider. Percentiles use the nearest-rank method.

## Diagnostic observations

The [aggregate diagnostic](03-pool-and-lock-diagnostic-aggregate.json) recorded a peak of 40 queued pool requests, ten pool connections and nine simultaneous advisory-lock queries. Its command advisory-lock wait p95 was 903.790 ms, and read pool-acquisition p95 was 230.555 ms. This identifies queue and lock costs in that diagnostic; it does not establish the cause of every difference between runs or prove that one change alone would meet the target.

The private preload retained only aggregate durations, counts and named categories. It recorded no SQL, parameters, result rows or credentials. Its timings include bootstrap and warmup and have unquantified wrapper overhead, so they are diagnostic evidence. During that run, three proof-only wrapper calls in `scripts/runtime-contribution-boundaries.ts` were being corrected outside the runtime source fingerprint. The runtime fingerprint stayed unchanged; the whole working tree is not represented as clean `ee7cb613`.

Root coordinated the measurements while owned browser, build and test work was stopped. The process reported five logical CPUs. A later separate read of the cgroup CPU selector showed `800000 200000`, equivalent to four CPUs of quota. That selector was not sampled throughout every run, and shared-host or quota effects do not excuse a missed target. No such causal explanation is asserted.

## What this establishes

The final source met the QL04 p95 target in one bounded local rehearsal. It does not establish production capacity, an all-requests latency bound, monthly availability, an SLA, real authentication-provider performance or physical-device acceptance. QL01 durability, QL02 clock accuracy, QL03 lower-end phone responsiveness, QL05 viewer freshness and the other original quality targets retain their separate evidence and acceptance conditions. No paid service or real child data was used.
