#!/usr/bin/env bash
# Publish the verified source without rewinding a development branch that moved ahead.
set -euo pipefail
metadata_directory="${1:-preview}"
bundle_path="${2:-/tmp/longball-source.bundle}"
base64 --decode "$metadata_directory/source.bundle.base64" >"$bundle_path"
printf '%s  %s\n' "$(cat "$metadata_directory/source.bundle.sha256")" "$bundle_path" | sha256sum --check
git bundle verify "$bundle_path"
source_branch="$(cat "$metadata_directory/source-branch.txt")"
source_revision="$(cat "$metadata_directory/source-head.txt")"
git check-ref-format --branch "$source_branch"
git fetch "$bundle_path" "$source_branch"
test "$(git rev-parse FETCH_HEAD)" = "$source_revision"
if git ls-remote --exit-code origin "refs/heads/$source_branch" >/dev/null; then
  git fetch origin "refs/heads/$source_branch"
  remote_revision="$(git rev-parse FETCH_HEAD)"
  if git merge-base --is-ancestor "$source_revision" "$remote_revision"; then
    printf 'Verified source is already published; preserving the current development branch.\n'
    exit 0
  fi
  if ! git merge-base --is-ancestor "$remote_revision" "$source_revision"; then
    printf 'Development history diverged; source publication requires review.\n' >&2
    exit 1
  fi
fi
# A concurrent push is rejected by Git. No force update is permitted.
git push origin "${source_revision}:refs/heads/${source_branch}"
