#!/usr/bin/env bash
set -euo pipefail
runtime_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"
}
for name in longball-clamd-runtime longball-postgres-runtime; do
  if runtime_docker inspect "$name" >/dev/null 2>&1; then
    test "$(runtime_docker inspect --format '{{index .Config.Labels "dev.longball.runtime"}}' "$name")" = true
    runtime_docker stop "$name"
  fi
done
