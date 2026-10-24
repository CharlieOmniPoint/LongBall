#!/usr/bin/env bash
# Disposable fictional Linux runtime proof. Never starts a paid/hosted service.
set -euo pipefail
LONGBALL_RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$LONGBALL_RUNTIME_ROOT"
postgres_image='postgres@sha256:1267c7e692de235fda2a50dbcdbcbca4672ea6a0298576a6bd9d07cafc319b32'
clamav_image='clamav/clamav@sha256:e19130cdebaeacc71fa46eab3ed6f69941f2f22aa5e08d55e9197f8edf43ce5e'
postgres_name='longball-postgres-runtime'
clamav_name='longball-clamd-runtime'
postgres_port="${LONGBALL_RUNTIME_POSTGRES_PORT:-55432}"
clamav_port="${LONGBALL_RUNTIME_CLAMD_PORT:-53310}"
mkdir -p .local/runtime
chmod 700 .local/runtime
cp infra/runtime/clamd.conf .local/runtime/clamd.conf
runtime_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"
}
runtime_docker info --format '{{.ServerVersion}}' >/dev/null
for image in "$postgres_image" "$clamav_image"; do
  if ! runtime_docker image inspect "$image" >/dev/null 2>&1; then runtime_docker pull "$image"; fi
done
reuse_owned() {
  if runtime_docker inspect "$1" >/dev/null 2>&1; then
    test "$(runtime_docker inspect --format '{{index .Config.Labels "dev.longball.runtime"}}' "$1")" = true || { printf 'Refusing an unowned runtime container.\n' >&2; exit 1; }
    test "$(runtime_docker inspect --format '{{.Config.Image}}' "$1")" = "$2" || { printf 'Refusing a runtime with a different image.\n' >&2; exit 1; }
    test "$(runtime_docker inspect --format '{{.State.Running}}' "$1")" = true || { printf 'Expected runtime is stopped; inspect it before recovery.\n' >&2; exit 1; }
    return 0
  fi
  return 1
}
assert_loopback_port() {
  local bindings
  bindings="$(runtime_docker inspect --format "{{json (index .NetworkSettings.Ports \"$2/tcp\")}}" "$1")"
  LONGBALL_BINDINGS="$bindings" LONGBALL_EXPECTED_PORT="$3" node --input-type=module - <<'JS'
const bindings=JSON.parse(process.env.LONGBALL_BINDINGS);
if(!Array.isArray(bindings)||bindings.length!==1||bindings[0].HostIp!=='127.0.0.1'||bindings[0].HostPort!==process.env.LONGBALL_EXPECTED_PORT){
  console.error('The owned runtime port differs from the requested loopback binding. Preserve it and choose the existing port or explicitly stop/restart the test runtime.');
  process.exitCode=1;
}
JS
}
if ! reuse_owned "$postgres_name" "$postgres_image"; then
  runtime_docker run --detach --rm --name "$postgres_name" --label dev.longball.runtime=true \
    --publish "127.0.0.1:${postgres_port}:5432" --env POSTGRES_HOST_AUTH_METHOD=trust \
    --env POSTGRES_DB=longball_runtime_test --env POSTGRES_INITDB_ARGS='--encoding=UTF8 --locale=C' "$postgres_image"
fi
if ! reuse_owned "$clamav_name" "$clamav_image"; then
  runtime_docker run --detach --rm --name "$clamav_name" --label dev.longball.runtime=true \
    --publish "127.0.0.1:${clamav_port}:3310" --memory=2g --cpus=2 --read-only --tmpfs /tmp:rw,size=128m,mode=1777 \
    --health-cmd='clamdscan --config-file=/run/longball-clamd.conf --ping=1' --health-interval=15s --health-timeout=5s --health-start-period=120s --health-retries=3 \
    --mount "type=bind,src=$LONGBALL_RUNTIME_ROOT/.local/runtime/clamd.conf,dst=/run/longball-clamd.conf,readonly" \
    --entrypoint /usr/sbin/clamd "$clamav_image" --config-file=/run/longball-clamd.conf --foreground
fi
assert_loopback_port "$postgres_name" 5432 "$postgres_port"
assert_loopback_port "$clamav_name" 3310 "$clamav_port"
ready=false
for attempt in {1..120}; do
  if runtime_docker exec "$postgres_name" pg_isready -U postgres -d longball_runtime_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
export LONGBALL_CLAMD_HOST=127.0.0.1 LONGBALL_CLAMD_PORT="$clamav_port"
ready=false
for attempt in {1..120}; do
  if node --input-type=module - <<'JS'
import net from 'node:net';
const socket=net.connect({host:process.env.LONGBALL_CLAMD_HOST,port:Number(process.env.LONGBALL_CLAMD_PORT)});
let replied=false;
socket.setTimeout(500,()=>socket.destroy(new Error('Not ready')));
socket.on('connect',()=>socket.write('zPING\0'));
socket.on('data',b=>{if(b.toString()==='PONG\0'){replied=true;socket.destroy();}else{socket.destroy();process.exitCode=1;}});
socket.on('error',()=>{process.exitCode=1;});
socket.on('close',()=>{if(!replied)process.exitCode=1;});
JS
  then ready=true; break; fi
  sleep 1
done
test "$ready" = true
{
  printf 'export LONGBALL_POSTGRES_TEST_URL=%q\n' "postgresql://127.0.0.1:${postgres_port}/longball_runtime_test"
  printf 'export PGUSER=%q\n' postgres
  printf 'export LONGBALL_CLAMD_HOST=%q\n' 127.0.0.1
  printf 'export LONGBALL_CLAMD_PORT=%q\n' "$clamav_port"
  printf 'export LONGBALL_RUNTIME_POSTGRES_CONTAINER=%q\n' "$postgres_name"
  printf 'export LONGBALL_RUNTIME_CLAMD_CONTAINER=%q\n' "$clamav_name"
} >.local/runtime/runtime.env
chmod 600 .local/runtime/runtime.env
runtime_docker exec "$postgres_name" postgres --version
runtime_docker exec "$clamav_name" clamscan --version
runtime_docker exec "$clamav_name" sigtool --info /var/lib/clamav/daily.cvd >.local/runtime/daily-signatures.txt
runtime_docker exec "$clamav_name" sigtool --info /var/lib/clamav/main.cvd >.local/runtime/main-signatures.txt
printf 'Disposable runtime ready. Source .local/runtime/runtime.env, then run the runtime proof.\n'
