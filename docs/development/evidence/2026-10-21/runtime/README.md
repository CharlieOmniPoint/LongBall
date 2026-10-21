# Actual database and scanner checkpoint

Executed 21 October 2026 in the managed Linux workspace against the in-progress development tree. These are actual disposable runtimes, not in-memory substitutes or fixture-scanner outcomes.

- PostgreSQL 18.6, official image pinned to `sha256:1267c7e692de235fda2a50dbcdbcbca4672ea6a0298576a6bd9d07cafc319b32`.
- ClamAV 1.5.4, official vendor image pinned to the digest in `clamav-databases.json`. `sigtool --info` verified the included main/daily database digital signatures. Daily 28157 was built 18 October.
- The real INSTREAM adapter accepted harmless bytes and rejected the standard harmless EICAR antivirus test pattern. Detection of every image-overlay context is not claimed; the tested PNG overlay was removed by bounded re-encoding.
- The async PostgreSQL manifest pipeline scanned/decoded the generated image, stripped metadata, preserved orientation, kept pending bytes private and required explicit publication. An interrupted community/manifest transaction rolled back both changes.
- Fifty concurrent real transactions committed exactly fifty increments. This is a small correctness smoke check, not load/capacity acceptance.
- Actual `pg_dump --format=custom` and `pg_restore` into a new database, paired with the private object archive, recovered three manifests, community state and the identical published derivative hash. A database-only backup cannot recover image files.

Reproduce with pinned Node/pnpm and Docker on Linux:

```bash
bash infra/runtime/start.sh
source .local/runtime/runtime.env
node --import tsx scripts/runtime-media.ts
```

`runtime-media.ts` creates fresh, fictional-only databases. Loopback-only trust authentication is a disposable test configuration, not a deployment security prescription. Private dumps/objects and detailed reports remain under ignored `.local/runtime/`. No real children or images were used, and no hosted service or paid resource was provisioned.

The additional `container-runtime-proof.json` records an actual clean image build and private Docker deployment. The API and worker ran as `node` with read-only roots and distinct restricted URL secrets; a separate non-superuser schema owner applied migrations. Real PostgreSQL permission denials are in `api-permissions.json` and `worker-permissions.json`. The API returned 200 for health and `503 IDENTITY_NOT_CONFIGURED` for a private request because this rehearsal intentionally has no OIDC provider configuration.

`worker-business.json` records the real restricted worker finalising one fictional award, retaining its original full-time-plus-60-minute deadline, and processing notification jobs with zero provider acceptance. Four remained blocked and fourteen were suppressed by current authorization/preferences. No push message was delivered. The running API also reached the pinned scanner at its private Docker address without a published scanner port. See [the runtime instructions](../../../../../infra/runtime/README.md) to reproduce the image, permission and fictional business checks.

The production image executed its separate bounded decoder as `node`, applied image orientation and removed metadata from actual generated JPEG derivatives. The later bounded identity-trial database bootstrap also ran successfully against the disposable loopback PostgreSQL instance, creating a fresh named database and dedicated restricted roles with the shared grant policy. This database checkpoint does not itself establish a successful provider-to-API identity journey; that evidence is recorded separately by the identity trial.

Operating scanner updates/monitoring, encrypted offsite backup, retention, recovery ownership, RPO/RTO targets and capacity acceptance remain separate work. Restricted production-style role checks are recorded separately when executed. Device evidence and identity/competition approvals are not established by this checkpoint.

`privacy-migration-004.json` is the later request-scope expansion checkpoint. Three actual PostgreSQL tests verify preservation of duplicate/history rows, exact canonical keys, transactional rollback, version checks and restricted runtime grants. The named fictional identity database was upgraded through migration4 with no request rows lost or policy approval created. The earlier container image record remains a migration3 checkpoint; it does not claim to include this later expansion.

`container-runtime-schema4-proof.json` records the subsequent clean image build and private deployment upgrade through004 using the dedicated schema owner. API/worker restarted in verify-only mode as `node` with read-only roots, and the running image's004 SQL hash matched the source. All restricted role checks passed, including worker denial for both privacy requests and canonical pending keys. No privacy action was executed; the earlier comprehensive scanner/media/paired-restore checkpoint was retained rather than represented as a new run.
