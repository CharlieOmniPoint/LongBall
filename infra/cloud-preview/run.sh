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
    'audience': 'Adult review of fictional Roma U10 data only',
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

export LONGBALL_SYNTHETIC_AUTH=1
export LONGBALL_API_HOST=127.0.0.1
export LONGBALL_API_PORT=4173
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
# One-time fictional review invitations return to the existing static app entry.
# Recipients still choose the explicit review service; links supply no API/role authority.
export LONGBALL_PUBLIC_APP_ENTRY_URL="https://charlieomnipoint.github.io/LongBall/"
export LONGBALL_INVITATION_POLICY_VERSION="fictional-review-invitation-v1"
# No default expiry: the review issuer must select its duration explicitly.
node backend/api.mjs >/tmp/longball-http.log 2>&1 &
server_pid=$!
server_ready=false
for attempt in {1..60}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:4173/health >/tmp/longball-health.json; then server_ready=true; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat /tmp/longball-http.log; exit 1; fi
  sleep 1
done
if [[ "$server_ready" != true ]]; then cat /tmp/longball-http.log; exit 1; fi
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
export PREVIEW_EXPIRES_AT="$(date -u -d '+60 minutes' +%Y-%m-%dT%H:%M:%SZ)"
publish_status ready
printf '## LongBall fictional review\n\n%s\n\nExpires at %s (UTC). No real team data or child accounts.\n' "$PREVIEW_URL" "$PREVIEW_EXPIRES_AT" >>"$GITHUB_STEP_SUMMARY"

# Bounded, free review session; no service subscription or persistent infrastructure.
for minute in {1..60}; do
  kill -0 "$server_pid"
  kill -0 "$tunnel_pid"
  kill -0 "$worker_pid"
  [[ "$(docker inspect --format '{{.State.Running}}' "$scanner_container")" == true ]]
  sleep 60
done
