#!/usr/bin/env bash
# Run on a separate, standard public GitHub Actions runner, not the Codex workspace.
set -euo pipefail

export PREVIEW_URL=""
export PREVIEW_SOURCE_REVISION="${GITHUB_SHA:?}"
export PREVIEW_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PREVIEW_EXPIRES_AT=""
server_pid=""
tunnel_pid=""
worker_pid=""
scanner_container=""
scanner_volume=""
export_key_directory=""
demo_accounts_file=""

# Verifiers are a separate, explicit demo-only runtime input. The source bundle
# and browser export never contain the chat-only plaintext credentials.
demo_account_login="$(python3 - <<'PY'
import hashlib, json, re
from pathlib import Path
preview = Path('preview')
request = json.loads((preview / 'native-build-request.txt').read_text())
enabled = request.get('demo_account_login', False)
if type(enabled) is not bool:
    raise SystemExit('Invalid demo-login build marker.')
config, digest = preview / 'demo-accounts.json', preview / 'demo-accounts.sha256'
if enabled:
    if any(path.is_symlink() or not path.is_file() for path in [config, digest]) or config.stat().st_size >65536:
        raise SystemExit('Missing or invalid demo verifier transport.')
    expected = digest.read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{64}', expected) or hashlib.sha256(config.read_bytes()).hexdigest() != expected:
        raise SystemExit('Demo verifier transport digest does not match.')
elif config.exists() or digest.exists():
    raise SystemExit('Unexpected stale demo verifier transport.')
print(int(enabled))
PY
)"
if [[ "$demo_account_login" == 1 ]]; then demo_accounts_file="$PWD/preview/demo-accounts.json"; fi
# Bootstrap media over loopback before exposing the credential-required server.
unset LONGBALL_DEMO_ACCOUNTS_FILE

publish_status() {
  export PREVIEW_STATE="$1"
  python3 - <<'PY'
import json, os
from pathlib import Path
Path('preview-status.json').write_text(json.dumps({
    'state': os.environ['PREVIEW_STATE'],
    'url': os.environ['PREVIEW_URL'],
    'sourceRevision': os.environ['PREVIEW_SOURCE_REVISION'],
    'runUrl': f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
    'startedAt': os.environ['PREVIEW_STARTED_AT'],
    'expiresAt': os.environ['PREVIEW_EXPIRES_AT'],
    'audience': 'LongBall demo review with simulated Roma U10 teams and matches',
}, indent=2) + '\n')
PY
  git add preview-status.json
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -m "Record ${PREVIEW_STATE} cloud review session [skip ci]"
  git push origin "HEAD:${GITHUB_REF_NAME}"
}

cleanup() {
  result=$?
  trap - EXIT
  if [[ -n "$tunnel_pid" ]]; then kill "$tunnel_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  if [[ -n "$scanner_container" ]]; then docker rm --force "$scanner_container" >/dev/null 2>&1 || true; fi
  if [[ -n "$scanner_volume" ]]; then docker volume rm "$scanner_volume" >/dev/null 2>&1 || true; fi
  if [[ -n "$export_key_directory" ]]; then rm -rf -- "$export_key_directory"; fi
  if [[ $result -eq 0 ]]; then
    publish_status stopped || true
  else
    publish_status failed || true
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

publish_status starting

if [[ -f preview/source.bundle.base64 ]]; then
  bash preview/publish-source.sh
fi

curl --fail --location --retry 3 --max-time 120 \
  https://github.com/cloudflare/cloudflared/releases/download/2026.10.2/cloudflared-linux-amd64 \
  --output /tmp/longball-cloudflared
printf '%s\n' '35fbdd2beb378436c7da377d7358cea8e33f9c94a6705d1d8036bf9b0d6d8005  /tmp/longball-cloudflared' | sha256sum --check
chmod +x /tmp/longball-cloudflared

# GitHub text payloads carry the licensed font explicitly as base64.
if [[ -f backend/assets/fonts/DejaVuSans.ttf.base64 ]]; then
  base64 --decode backend/assets/fonts/DejaVuSans.ttf.base64 >backend/assets/fonts/DejaVuSans.ttf
fi
printf '%s\n' '57f73e11f51999432bf7ab22ce55b6f945d5eca1bf824404cfa9ec2e3718c84e  backend/assets/fonts/DejaVuSans.ttf' | sha256sum --check
# A fresh private key per bounded review session; older session exports fail closed.
export_key_directory="$(mktemp -d /tmp/longball-export-key.XXXXXXXX)"
chmod 700 "$export_key_directory"
export LONGBALL_EXPORT_ENCRYPTION_KEY_FILE="$export_key_directory/key"
export LONGBALL_EXPORT_TTL_MS=3600000
node --input-type=module - <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LONGBALL_EXPORT_ENCRYPTION_KEY_FILE, randomBytes(32).toString('hex') + '\n', {mode:0o600,flag:'wx'});
JS
export LONGBALL_SYNTHETIC_AUTH=1
# Explicit generated-demo sharing is separate from real competition policy.
export LONGBALL_DEMO_SCENARIO=1
export LONGBALL_API_HOST=127.0.0.1
export LONGBALL_API_PORT=4173
# Explicit fictional-only clock exchange fixture, never a production policy default.
export LONGBALL_FICTIONAL_CLOCK_POLICY='{"id":"fictional-cloud-review-clock-v1","serverClockUncertaintyMs":1000,"maximumRoundTripMs":5000,"maximumMappingAgeMs":3600000,"maximumUncertaintyMs":3000,"maximumDriftPpm":100}'
export LONGBALL_API_DATABASE="$PWD/.local/fictional-review.sqlite"
export LONGBALL_MEDIA_DIRECTORY="$PWD/.local/private-review-media"
export LONGBALL_HEIC_DECODER_FILE="$PWD/.local/heic-runtime/bin/longball-heic"
export LONGBALL_CLAMD_HOST=127.0.0.1
export LONGBALL_CLAMD_PORT=53310
scanner_container="longball-review-scanner-${GITHUB_RUN_ID}"
scanner_volume="longball-review-signatures-${GITHUB_RUN_ID}"
scanner_image='clamav/clamav@sha256:e19130cdebaeacc71fa46eab3ed6f69941f2f22aa5e08d55e9197f8edf43ce5e'
docker volume create "$scanner_volume" >/dev/null
# A disposable signature update uses the upstream configured endpoints. Readiness
# below still requires a working engine, recent signatures and actual verdicts.
timeout 300 docker run --rm --memory=2g --cpus=2 --volume "$scanner_volume:/var/lib/clamav" \
  --entrypoint /usr/bin/freshclam "$scanner_image" --stdout >/tmp/longball-freshclam.log 2>&1 || true
docker run --detach --name "$scanner_container" --read-only --memory=2g --cpus=2 \
  --tmpfs /tmp:rw,size=128m,mode=1777 --publish 127.0.0.1:53310:3310 \
  --volume "$scanner_volume:/var/lib/clamav:ro" --volume "$PWD/preview/clamd.conf:/run/longball-clamd.conf:ro" \
  --entrypoint /usr/sbin/clamd "$scanner_image" --config-file=/run/longball-clamd.conf --foreground >/tmp/longball-scanner-container.txt
media_ready=false
for attempt in {1..180}; do
  if node preview/check-media.mjs >/tmp/longball-media-readiness.json 2>/tmp/longball-media-readiness-error.log; then media_ready=true; break; fi
  sleep 1
done
if [[ "$media_ready" != true ]]; then
  cat /tmp/longball-media-readiness-error.log
  docker logs "$scanner_container"
  exit 1
fi
export LONGBALL_STATIC_DIRECTORY="$PWD/site"
# The lasting fictional Pages review can explicitly connect to this bounded API
# session. Same-origin combined review remains supported by the server itself.
export LONGBALL_API_ORIGINS="https://charlieomnipoint.github.io"
# The combined demo also checks the pinned public service-status document.
export LONGBALL_OIDC_CONNECT_ORIGINS="https://raw.githubusercontent.com"
# One-time fictional review invitations return to the existing static app entry.
# Recipients still choose the explicit review service; links supply no API/role authority.
export LONGBALL_PUBLIC_APP_ENTRY_URL="https://charlieomnipoint.github.io/LongBall/"
export LONGBALL_INVITATION_POLICY_VERSION="fictional-review-invitation-v1"
# No default expiry: the review issuer must select its duration explicitly.
start_review_api() {
  node backend/api.mjs >>/tmp/longball-http.log 2>&1 &
  server_pid=$!
  local server_ready=false
  for attempt in {1..60}; do
    if curl --silent --fail --max-time 2 http://127.0.0.1:4173/health >/tmp/longball-health.json; then server_ready=true; break; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then cat /tmp/longball-http.log; exit 1; fi
    sleep 1
  done
  if [[ "$server_ready" != true ]]; then cat /tmp/longball-http.log; exit 1; fi
}
start_review_api
# Create sample gallery/moderation records through real scanning and the private gateway.
node preview/seed-demo-media.mjs http://127.0.0.1:4173 >/tmp/longball-demo-media.json
if [[ "$demo_account_login" == 1 ]]; then
  # The bootstrap server has no public tunnel. Close it before enabling login;
  # the same database and private files retain the scanner-approved examples.
  kill -TERM "$server_pid"
  wait "$server_pid"
  server_pid=""
  export LONGBALL_DEMO_ACCOUNTS_FILE="$demo_accounts_file"
  start_review_api
  python3 - <<'PY'
import json
from pathlib import Path
health = json.loads(Path('/tmp/longball-health.json').read_text())
if health.get('syntheticOnly') is not True or health.get('demoAccountLogin') is not True:
    raise SystemExit('The credential-required demo API did not become ready.')
PY
  for legacy in synthetic-manager-2 synthetic-admin synthetic-account-player-01 synthetic-spectator; do
    status="$(curl --silent --max-time 5 --output /tmp/longball-legacy-probe.json --write-out '%{http_code}' \
      --header "Authorization: Bearer $legacy" http://127.0.0.1:4173/v1/me)"
    if [[ "$status" != 401 ]]; then printf 'Legacy demo identity was not refused.\n' >&2; exit 1; fi
  done
fi
node backend/worker.mjs >/tmp/longball-worker.log 2>&1 &
worker_pid=$!
/tmp/longball-cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4173 >/tmp/longball-tunnel.log 2>&1 &
tunnel_pid=$!

for attempt in {1..90}; do
  PREVIEW_URL="$(sed -nE 's/.*(https:\/\/[a-z0-9-]+\.trycloudflare\.com).*/\1/p' /tmp/longball-tunnel.log | sed '/^https:\/\/api\.trycloudflare\.com$/d' | head -1)"
  if [[ -n "$PREVIEW_URL" ]] && curl --silent --fail --connect-timeout 3 --max-time 5 "$PREVIEW_URL" >/tmp/longball-public.html; then
    if python3 -c "from pathlib import Path; import sys; sys.exit('LongBall' not in Path('/tmp/longball-public.html').read_text())"; then break; fi
  fi
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then cat /tmp/longball-tunnel.log; exit 1; fi
  sleep 2
done
if [[ -z "$PREVIEW_URL" ]] || ! python3 -c "from pathlib import Path; import sys; sys.exit('LongBall' not in Path('/tmp/longball-public.html').read_text())"; then
  cat /tmp/longball-tunnel.log /tmp/longball-http.log
  exit 1
fi
export PREVIEW_URL
export PREVIEW_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PREVIEW_EXPIRES_AT="$(date -u -d '+300 minutes' +%Y-%m-%dT%H:%M:%SZ)"
publish_status ready
printf '## LongBall demo review\n\n%s\n\nExpires at %s (UTC). Sample teams and matches for functionality testing.\n' "$PREVIEW_URL" "$PREVIEW_EXPIRES_AT" >>"$GITHUB_STEP_SUMMARY"

# Bounded, free review session; no service subscription or persistent infrastructure.
for minute in {1..300}; do
  kill -0 "$server_pid"
  kill -0 "$tunnel_pid"
  kill -0 "$worker_pid"
  [[ "$(docker inspect --format '{{.State.Running}}' "$scanner_container")" == true ]]
  sleep 60
done
