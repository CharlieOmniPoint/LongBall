# Runtime and deployment rehearsal

This is local preparation for the native application and its phone-friendly browser/API review. It provisions no hosted or paid service. Use fictional data. The actual PostgreSQL, image-processing, scanner and paired restore checkpoint is recorded in [the runtime evidence](../../docs/development/evidence/2026-10-21/runtime/README.md).

The API, worker and migrator are three commands in one Node 24.19.0 image. Runtime dependencies are pinned to pg 8.23.1 and sharp 0.35.5; the compiler is esbuild 0.28.2. The image installs production dependencies separately from compilation. Node, PostgreSQL 18.6 and ClamAV 1.5.4 base images are pinned by digest. The image runs as the unprivileged `node` user, with private image files under `/data/media`.

## Actual disposable integration proof

With the repository's Node/pnpm dependencies installed and a local Linux Docker engine available:

```bash
bash infra/runtime/start.sh
source .local/runtime/runtime.env
node --import tsx scripts/runtime-media.ts
```

This creates fresh fictional test databases and private files under ignored `.local/runtime`. It uses loopback-only trust authentication solely for the disposable test. It verifies real scanner responses, metadata stripping, pending/publication boundaries, transactional manifest links, 50 concurrent increments, actual `pg_dump`/`pg_restore`, and the matching object copy. Stop only these owned runtimes with `bash infra/runtime/stop.sh`. That command does not remove evidence or stop unrelated containers.

## Build and rehearse restricted deployment

From the repository root:

```bash
docker build --file infra/runtime/Dockerfile --tag longball-runtime:local .
node infra/runtime/create-secrets.mjs
docker compose --file infra/runtime/compose.yaml up -d database scanner
docker compose --file infra/runtime/compose.yaml run --rm migrate
docker compose --file infra/runtime/compose.yaml up -d api worker
curl --fail http://127.0.0.1:4310/health
```

In a managed workspace, preserve the configured Docker proxy and use `--secret id=proxy_ca,src="$CODEX_PROXY_CERT"` for the build. The certificate is mounted for dependency installation and never copied into image layers. If the default buildx cache is read-only, set `BUILDX_CONFIG="$PWD/.local/runtime/buildx"`. Keep Docker registry configuration and credentials unchanged.

`create-secrets.mjs` refuses to overwrite files. Its directory is private; generated files are mountable by the container users. The PostgreSQL bootstrap administrator creates three separate login roles on an empty volume. `longball_migrator` owns only the application schema and cannot create roles/databases. `longball_api` can select, insert and update domain tables; it cannot delete rows, rewrite append-only evidence, change schema or modify migration versions. `longball_worker` can select current accounts/memberships/matches for fresh notification authorization and select/insert/update jobs and community documents. It cannot change accounts, read private media manifests or alter schema. Neither runtime receives the migration/admin secret. Startup verifies migration versions, installed RLS, non-owner and NOBYPASSRLS role attributes using SELECT statements; missing or newer migrations stop startup. The migrator applies runtime migrations 002–009 plus the media/activation feature schemas and grants. Rerun it with each compatible release before starting runtime processes. PostgreSQL RLS covers 28 account/tenant tables with transaction-local verified identity and selected team/season/role context; composite foreign keys derive game/media ancestry from recorded parents. A migrator-owned login-purpose map prevents the worker from adopting API identity contexts and the API from adopting worker leases. The worker claims bounded due jobs through a protected function, then reads only its exact live lease and recipient/scope; award fanout uses a separate bounded function. Missing or unresolved legacy club ancestry stays retained and runtime-denied. JSON document field redaction remains the application projection’s responsibility.

Only `127.0.0.1:4310` is published. PostgreSQL and ClamAV have no published ports; their Docker network is internal. There is no identity-admin service or port. The API has a separate egress network for a configured OIDC provider. Set `LONGBALL_OIDC_ISSUER`, `LONGBALL_OIDC_AUDIENCE`, `LONGBALL_OIDC_JWKS_URI` and reviewed `LONGBALL_API_ORIGINS` before authenticated review. Without identity configuration, health responds successfully while private requests return `503 IDENTITY_NOT_CONFIGURED`. Synthetic authentication is forbidden in this production image. Activation and trusted match-clock policy remain disabled until their explicit configuration/approval requirements are met.

For a browser export, run the repository `build:web` task and serve its `apps/mobile/dist-web` output through the reviewed HTTPS origin, or mount it read-only and set `LONGBALL_STATIC_DIRECTORY`. Configure the browser OIDC client and CORS for that exact origin. This image contains the API/worker rather than silently publishing an identity provider or a public website. A durable sharing URL and TLS reverse proxy are deployment decisions; the existing temporary fictional review link is a separate process.

`docker compose ... down` stops this rehearsal without deleting volumes. Do not add `--volumes` unless deliberately discarding its fictional database and private objects. Secret rotation and an existing-volume credential change require an explicit operator procedure; changing a secret file does not reset an existing database password.

Check actual database privileges through the running restricted processes:

```bash
docker compose --file infra/runtime/compose.yaml exec -T api \
  node --input-type=module - api < infra/runtime/check-permissions.mjs
docker compose --file infra/runtime/compose.yaml exec -T worker \
  node --input-type=module - worker < infra/runtime/check-permissions.mjs
docker compose --file infra/runtime/compose.yaml exec -T api \
  node --input-type=module - < infra/runtime/check-decoder.mjs
```

On a **fresh fictional rehearsal database only**, first seed fictional Roma data once through the separately credentialled operator fixture port, close that connection, and run the business proof through its two restricted role URLs. The restricted API cannot seed catalogues. The proof finalises an award through the real restricted worker, preserves the original full-time-plus-60-minute deadline, and verifies notifications stay blocked without a provider. It deliberately requires an unsealed fixture and does not send push messages. The serving API/worker retain their separate secrets; only this disposable proof command mounts both restricted URLs.

```bash
docker compose --file infra/runtime/compose.yaml stop worker
node infra/runtime/build-proof.mjs
docker compose --file infra/runtime/compose.yaml run --rm runtime-proof
docker compose --file infra/runtime/compose.yaml start worker
```

An optional public-runner template, `ci.yml`, reproduces the real media/restore test for an exact public source commit. It is not installed as a workflow here and no remote CI success is claimed for it.

The separate fictional identity-provider trial can obtain an isolated database with `LONGBALL_IDENTITY_TRIAL_BOOTSTRAP=1 node --import tsx scripts/bootstrap-identity-trial-db.ts` after sourcing `.local/runtime/runtime.env`. That bounded helper creates exactly `longball_identity_trial` and three dedicated restricted roles, migrates it, and writes only private URL-file selectors under `.local/identity/database`. It refuses existing selectors/databases/roles, seeds no fixture and creates no identity provider. Its named roles use the same `applyRuntimeGrants` policy as the container migrator. The provider-trial bootstrap may use the schema owner once for explicitly tagged fictional fixtures, then must close it and serve with the restricted API URL in verify-only mode.

## Affected security restore

After one successful `runtime-media.ts` checkpoint, run `source .local/runtime/runtime.env` and `node --import tsx scripts/runtime-rls-restore.ts`. It preserves the original checkpoint, restores its archive into a new fictional database under a dedicated non-bypass schema owner, applies migrations through 009 plus feature security 2, takes a fresh archive and copies its matching private objects, then restores again. Actual restricted API/worker roles verify the restored 28 RLS tables, 23 composite foreign keys, exact published image hash and current context denials. It reuses the already processed harmless image; it does not rerun or renew the scanner/signature claim. Temporary databases/roles are removed; the ignored private archive/object evidence remains under `.local/runtime/rls-restores`.

## Paired backup and recovery

The automated proof performs an actual custom-format dump and restore into a fresh database, copies private objects, and verifies the restored publication hash. This is a correctness checkpoint rather than an RPO/RTO or offsite-backup claim.

For a consistent local deployment snapshot, stop API/worker first and allow their in-flight work to finish. Keep the database running. Protect the output directory and take both parts of the same snapshot:

```bash
mkdir -p .local/runtime/backup
chmod 700 .local/runtime/backup
docker compose --file infra/runtime/compose.yaml stop api worker
docker compose --file infra/runtime/compose.yaml exec -T database \
  pg_dump -U postgres -d longball --format=custom \
  > .local/runtime/backup/database.dump
docker compose --file infra/runtime/compose.yaml run --rm --no-deps -T \
  --entrypoint tar migrate -C /data -cf - . \
  > .local/runtime/backup/objects.tar
sha256sum .local/runtime/backup/database.dump .local/runtime/backup/objects.tar \
  > .local/runtime/backup/SHA256SUMS
chmod 600 .local/runtime/backup/*
docker compose --file infra/runtime/compose.yaml start api worker
```

Recovery must target a fresh isolated deployment, never an active database. Bootstrap its empty database/roles first and keep API/worker stopped. The bootstrap administrator must temporarily grant `CREATE ON DATABASE longball TO longball_migrator` because the archive recreates the application schema, then run `pg_restore --no-owner --role=longball_migrator --clean --if-exists --exit-on-error` and revoke that temporary database privilege whether restore succeeds or fails. Extract the matching object archive into its empty `/data` volume as the `node` user. Re-run the migrator/grants, verify database records and derivative hashes, then start API/worker and verify authorization. The original media proof demonstrates a real database/object restore. The affected security rehearsal below also restores through a dedicated non-superuser schema owner, revokes temporary database CREATE, reapplies restricted runtime grants and proves current player image access plus foreign-team/worker-identity denial. A hosted operational recovery drill remains pending. A database-only restore cannot recover media.

Before real child data or a durable public deployment: operate and monitor scanner signature updates; define backup encryption, offsite copy, retention and restore ownership; accept capacity and recovery targets; select host/region/TLS/identity credentials; and resolve the recorded child-account, clock and publication policy decisions. The pinned scanner image contains verified vendor signatures dated 18 October 2026; it does not establish an ongoing update SLA. Physical iPhone/Android behavior still requires native device testing.
