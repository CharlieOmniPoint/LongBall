# Worker boundary

Reserved for PostgreSQL-backed jobs (DS01, PL06): notification delivery, image processing, award deadlines, exports and retention. No worker service is needed by the initial M0 lab. Add durable leases, retries, business-key idempotency and failure tests when implementing these workflows; do not add Redis by default.
