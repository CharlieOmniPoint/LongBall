# SEC17 audit clock correction

[The report](report.json) records an actual-current-time PostgreSQL HTTP regression. Before the correction, a dynamically advancing `Date.now()` request received HTTP 422 because the captured application timestamp could not equal a later volatile database observation. The corrected selected test passes with restricted API permissions and checks all retained audit fields against database time bounds, suspension/reinstatement, exact retry, stale/forged requests and immutable/private evidence.

Migration 015 adds a plain invoker `BEFORE INSERT` timestamp trigger and removes only the volatile timestamp equality from the existing manager/operation/actor/current-target row policy. Public execute permission is revoked. The repository no longer supplies `created_at`; existing audit rows remain unchanged.

The combined three-file regression invocation passed 34 checks and found one request-identity mistake in the new test. The corrected selected test then passed; the report distinguishes those runs and does not claim a single all-green combined invocation. The migration preservation, rollback and reopen checks passed in that combined run. Root integration and operational runtime proofs follow separately.
