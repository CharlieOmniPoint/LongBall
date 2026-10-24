#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/dev-env.sh
export CI=1

if [[ "$(node --version)" != "v$(cat .node-version)" ]]; then
  echo "Activate Node $(cat .node-version) with your version manager before setup." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null || [[ "$(pnpm --version)" != 11.25.0 ]]; then
  npm install --prefix .local/tooling --no-audit --no-fund pnpm@11.25.0
fi
pnpm install --frozen-lockfile
python3 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -r requirements-dev.txt
.venv/bin/python -m pip check
pnpm fixtures:synthetic
pnpm test:contracts
