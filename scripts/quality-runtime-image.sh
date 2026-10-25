#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# This creates disposable credentials/volumes only on a fresh public Actions
# runner, never by reusing the managed development machine's owned runtimes.
[[ "${GITHUB_ACTIONS:-}" == true ]]
[[ "${GITHUB_REPOSITORY:-}" == CharlieOmniPoint/LongBall ]]
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
[[ ! -e .local/runtime/deployment-secrets ]]
image="longball-runtime:quality-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
project="longball-quality-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
output="$PWD/.local/quality/runtime"
mkdir -p "$output"
docker build --file infra/runtime/Dockerfile --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt --tag "$image" .
node infra/runtime/create-secrets.mjs
# The clean checkout has no .env or provider configuration. Explicitly empty
# these fields again before resolving the private rehearsal configuration.
LONGBALL_OIDC_ISSUER= LONGBALL_OIDC_AUDIENCE= LONGBALL_OIDC_JWKS_URI= LONGBALL_API_ORIGINS= \
  docker compose --profile '*' --file infra/runtime/compose.yaml config --format json > "$output/resolved-private.json"
LONGBALL_QUALITY_IMAGE="$image" node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const path = '.local/quality/runtime/';
const config = JSON.parse(readFileSync(path + 'resolved-private.json', 'utf8'));
for (const name of ['migrate', 'api', 'worker', 'database', 'scanner'])
  if (!config.services?.[name]) throw new Error(`Resolved rehearsal must retain its ${name} service.`);
if (config.networks?.private?.internal !== true) throw new Error('The isolated rehearsal requires an internal private network.');
for (const [serviceName, secretName] of [['migrate', 'migrator_url'], ['api', 'api_url'], ['worker', 'worker_url']]) {
  const service = config.services[serviceName];
  if (service.image !== 'longball-runtime:local') throw new Error('Unexpected runtime image selector.');
  const secrets = service.secrets?.map(entry => typeof entry === 'string' ? entry : entry.source);
  if (secrets?.length !== 1 || secrets[0] !== secretName) throw new Error('Runtime roles must retain separate database secret selectors.');
  if (resolve(config.secrets?.[secretName]?.file ?? '') !== resolve('.local/runtime/deployment-secrets', secretName)) throw new Error('Rehearsal secret selector escaped its fresh deployment directory.');
}
delete config.name;
delete config.services['runtime-proof'];
delete config.networks.egress;
for (const network of Object.values(config.networks)) delete network.name;
for (const volume of Object.values(config.volumes)) delete volume.name;
for (const service of Object.values(config.services)) {
  if (service.image === 'longball-runtime:local') service.image = process.env.LONGBALL_QUALITY_IMAGE;
  delete service.ports;
  service.networks = ['private'];
}
config.services.api.volumes.push({ type: 'bind', source: resolve('fixtures/media/fictional.heic'), target: '/run/longball-image-fixture.heic', read_only: true });
writeFileSync(path + 'compose.json', JSON.stringify(config));
JS
compose=(docker compose --project-name "$project" --file "$output/compose.json")
cleanup() { "${compose[@]}" down --volumes --remove-orphans; }
trap cleanup EXIT
"${compose[@]}" up -d --wait --wait-timeout 180 database scanner
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d api worker
ready=false
for attempt in {1..30}; do
  if "${compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:4310/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
"${compose[@]}" exec -T api node --input-type=module - api < infra/runtime/check-permissions.mjs > "$output/api-permissions.json"
"${compose[@]}" exec -T worker node --input-type=module - worker < infra/runtime/check-permissions.mjs > "$output/worker-permissions.json"
"${compose[@]}" exec -T api node --input-type=module - < infra/runtime/check-decoder.mjs > "$output/jpeg-decoder.json"
"${compose[@]}" exec -T api node --input-type=module - < infra/runtime/check-image.mjs > "$output/image-checks.json"
docker image inspect "$image" --format '{{json .Id}}' > "$output/image-id.json"
for service in api worker; do
  container="$("${compose[@]}" ps -q "$service")"
  docker inspect "$container" --format '{"user":{{json .Config.User}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"publishedPorts":{{json .HostConfig.PortBindings}},"image":{{json .Image}}}' > "$output/$service-runtime.json"
done
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const path = '.local/quality/runtime/';
for (const service of ['api', 'worker']) {
  const runtime = JSON.parse(readFileSync(path + service + '-runtime.json'));
  assert.equal(runtime.user, 'node'); assert.equal(runtime.readOnlyRootfs, true);
  assert.equal(Object.keys(runtime.publishedPorts ?? {}).length, 0);
}
const proof = JSON.parse(readFileSync(path + 'image-checks.json'));
assert.equal(proof.passed, true);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(path + 'summary.json', JSON.stringify({ observedAt: new Date().toISOString(), passed: true, sourceCommit, imageId: JSON.parse(readFileSync(path + 'image-id.json')), apiSha256: proof.apiSha256, workerSha256: proof.workerSha256, checks: ['fresh exact-source production image', 'dedicated migrator', 'separate restricted API/worker schema16 checks', 'nonroot read-only runtimes', 'private networks and no host ports', 'health and unconfigured identity denial', 'actual maintained ClamAV clean/EICAR', 'actual image JPEG/HEIC orientation and metadata stripping'], pairedRestoreExercised: false, actualPushDelivered: false, physicalDeviceEvidence: false, paidServicesProvisioned: false }, null, 2) + '\n');
JS
