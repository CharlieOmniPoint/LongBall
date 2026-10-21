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
export LONGBALL_STATIC_DIRECTORY="$PWD/site"
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
  sleep 60
done
