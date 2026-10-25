#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/dev-env.sh
export EXPO_OFFLINE=1
exec pnpm --filter mobile start:dev-client "$@"
