#!/usr/bin/env bash
# Source from any directory: source /workspace/LongBall/scripts/dev-env.sh
LONGBALL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export npm_config_cache="$LONGBALL_ROOT/.local/npm-cache"
export PIP_CACHE_DIR="$LONGBALL_ROOT/.local/pip-cache"
export XDG_CACHE_HOME="$LONGBALL_ROOT/.local/cache"
export XDG_DATA_HOME="$LONGBALL_ROOT/.local/share"
export XDG_STATE_HOME="$LONGBALL_ROOT/.local/state"
export GRADLE_USER_HOME="$LONGBALL_ROOT/.local/gradle"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/workspace/longball-setup/android-home}"
export EXPO_NO_TELEMETRY=1
export PATH="$LONGBALL_ROOT/.local/tooling/node_modules/.bin:$PATH"
if [[ -d /workspace/longball-setup/android-sdk ]]; then
  export ANDROID_HOME="${ANDROID_HOME:-/workspace/longball-setup/android-sdk}"
  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
fi
