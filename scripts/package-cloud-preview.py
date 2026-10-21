"""Package a clean, committed fictional review for the connected GitHub tools.

This prepares files only. It never creates hosting, credentials or paid resources.
"""
import base64
import hashlib
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


if git("status", "--porcelain"):
    raise SystemExit("Commit the review candidate before packaging; uncommitted work was retained.")
branch = git("branch", "--show-current")
if not branch.startswith("dev/"):
    raise SystemExit("Package from a development branch.")
head = git("rev-parse", "HEAD")
# Build from the checked, committed tree instead of relabelling an older export.
for command in [["pnpm", "build:web"], ["pnpm", "build:api"]]:
    subprocess.run(command, cwd=root, check=True)
if git("rev-parse", "HEAD") != head or git("status", "--porcelain"):
    raise SystemExit("Source changed during the build; retain outputs and package again after committing.")
bundle = root / ".local/longball-source.bundle"
bundle.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(["git", "bundle", "create", str(bundle), branch, "^origin/main"], cwd=root, check=True)
entries = []


def include(path, content):
    entries.append({"path": path, "mode": "100644", "type": "blob", "content": content})


for local, destination in [
    ("apps/mobile/dist-web", "site"),
    ("apps/api/dist", "backend"),
]:
    directory = root / local
    if not directory.exists():
        raise SystemExit(f"Build {local} first.")
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"Refusing a symbolic link in the review export: {path}")
        if path.is_file() and (destination != "backend" or path.suffix == ".mjs"):
            include(f"{destination}/{path.relative_to(directory)}", path.read_text())

for source, destination in [
    ("infra/cloud-preview/run.sh", "preview/run.sh"),
    ("infra/cloud-preview/workflow.yml", ".github/workflows/cloud-preview.yml"),
    ("infra/cloud-preview/backend/package.json", "backend/package.json"),
    ("infra/cloud-preview/backend/package-lock.json", "backend/package-lock.json"),
    ("infra/ci/native-feasibility.yml", ".github/workflows/native-feasibility.yml"),
]:
    include(destination, (root / source).read_text())

raw = bundle.read_bytes()
include("preview/source.bundle.base64", base64.b64encode(raw).decode() + "\n")
include("preview/source.bundle.sha256", hashlib.sha256(raw).hexdigest() + "\n")
include("preview/source-head.txt", head + "\n")
include("preview/source-branch.txt", branch + "\n")
include("preview/native-build-request.txt", json.dumps({"source": head, "upload_artifacts": False}) + "\n")
include("site/build-info.json", json.dumps({"sourceCommit": head, "sourceBranch": branch, "synthetic": True, "nativeTargets": ["iPhone", "Android"], "production": False}, indent=2) + "\n")
output = root / ".local/cloud-preview-payload.json"
output.write_text(json.dumps(entries, ensure_ascii=True))
print(json.dumps({"payload": str(output), "characters": len(output.read_text()), "sourceCommit": head, "bundleBytes": len(raw), "files": len(entries)}))
