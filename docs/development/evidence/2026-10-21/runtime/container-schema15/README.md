# Schema 15 production image rehearsal: not run

The read-only assessment at **2026-10-21 20:01:29 UTC** found **2,396,745,728 bytes (2.23 GiB)** free on the workspace filesystem and about **12.28 GiB** of available memory. A new image build and separate database/scanner rehearsal were stopped before mutation because that disk margin was unsuitable alongside the final exports. No build, container creation, migration, deployment or new image acceptance is claimed. No services, secrets, tags, volumes or previous state were changed.

The existing `longball-runtime:local` image was observed as `sha256:c29d7caddb404740200ab2d1f701dac9478cf21bfe6ecc3d55cdca314a3e0abb`, created at 12:57 UTC, with configured user `node`. Its source and current schema compatibility were not verified in this assessment. Its running API, database and scanner were left untouched. Docker reported 416.4 MB of build cache, but this does not establish a cache hit for the HEIC compiler. No cache or image was pruned.

The separate [schema 15 host proofs](../schema15-operational/summary.json) **passed** against the owned PostgreSQL/ClamAV containers at 19:34–19:35 UTC: core migrations 2–15, media 1–4, activation 2, 37 RLS tables, real HEIC processing and paired private-object/database recovery. Those host-bundled proofs do not establish that a newly built production image was exercised.

## Prepared rehearsal

The inspected recipe builds one pinned Node 24.19 image for API, worker and migrator, with pg 8.23.1, sharp 0.35.5 and a source-built HEIC decoder. The API and worker run as `node`, use separate restricted database secrets and verify schemas at startup; the dedicated migrator alone receives its schema-owner URL. The existing Compose recipe uses read-only runtime root filesystems, private object/database volumes and an internal database/scanner network.

For a later run with adequate space, archive an exact committed source into a separate temporary directory and generate a **new** Compose configuration with a unique project/image tag, new secret files and new volumes. The generated configuration must remove all published ports and the API egress network for this isolated trial, omit OIDC/push configuration, and keep the repository recipe and existing selectors unchanged. Do not run the repository's fixed-path secret generator against existing selectors.

The following are **planned commands, not executed evidence**. `$snapshot` must name that committed source archive; `$rehearsal` must name the newly generated private selectors and Compose configuration. Docker must use the owned Unix socket with the unrelated inherited endpoint variables removed:

```bash
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock build \
  --file "$snapshot/infra/runtime/Dockerfile" \
  --secret id=proxy_ca,src="$CODEX_PROXY_CERT" \
  --tag longball-runtime:schema15-isolated "$snapshot"

env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock compose \
  --project-name longball-schema15-isolated --file "$rehearsal/compose.yaml" up -d database scanner

env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock compose \
  --project-name longball-schema15-isolated --file "$rehearsal/compose.yaml" run --rm migrate

env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock compose \
  --project-name longball-schema15-isolated --file "$rehearsal/compose.yaml" up -d api worker
```

Acceptance must inspect the actual image/source/API bundle hashes, non-root UID, read-only mounts and absence of host ports; assert core 2–15/media 1–4/activation 2 and exactly 37 expected protected tables; execute both `check-permissions.mjs` modes against their own runtime secrets; verify health and fail-closed private requests without configured identity; and execute the image's maintained decoder on a fictional HEIC with orientation/metadata assertions. API/worker startup must stay verify-only. A separately scoped fictional business proof may verify job authorization and blocked delivery without a provider. Missing cache layers, disk pressure or failed checks must be recorded as observed, rather than relabelled as acceptance.

No physical device, production identity, real push, hosted service, ongoing operations or paid resource is established by this assessment.
