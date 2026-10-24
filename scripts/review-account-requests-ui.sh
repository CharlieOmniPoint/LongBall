#!/usr/bin/env bash
set -euo pipefail
longball_root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$longball_root/.local/identity/browser-nss" "$longball_root/.local/identity/browser-review"
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock run --rm --network=host --memory=2g --cpus=2 \
  --mount "type=bind,src=$longball_root,dst=/work,readonly" \
  --tmpfs /work/.local:rw,size=128m,mode=1777 \
  --mount "type=bind,src=$longball_root/.local/identity/trial/manager-fixture.json,dst=/work/.local/identity/trial/manager-fixture.json,readonly" \
  --mount "type=bind,src=$longball_root/.local/identity/trial/ca.crt,dst=/work/.local/identity/trial/ca.crt,readonly" \
  --mount "type=bind,src=$longball_root/.local/identity/browser-review,dst=/work/.local/identity/browser-review" \
  --mount "type=bind,src=$longball_root/.local/identity/browser-nss,dst=/root/.local/share/pki/nssdb" \
  --env LONGBALL_IDENTITY_TRUST_ONLY="${LONGBALL_IDENTITY_TRUST_ONLY:-0}" \
  --env NODE_EXTRA_CA_CERTS=/work/.local/identity/trial/ca.crt \
  --entrypoint sh longball-identity-browser:local -euc '
    if [ ! -f /root/.local/share/pki/nssdb/cert9.db ]; then certutil -N -d sql:/root/.local/share/pki/nssdb --empty-password; fi
    certutil -D -d sql:/root/.local/share/pki/nssdb -n LongBallLocalTrialCA 2>/dev/null || true
    certutil -A -d sql:/root/.local/share/pki/nssdb -n LongBallLocalTrialCA -t "C,," -i /work/.local/identity/trial/ca.crt
    exec node scripts/account-requests-ui-review.mjs
  '
