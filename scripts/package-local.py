"""Create an offline local-Codex transfer without journals, credentials or dependencies."""
import hashlib
import io
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
export = root / "apps/mobile/dist-web"
if not (export / "index.html").is_file():
    raise SystemExit("Run pnpm build:web before packaging the local review.")
if subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip():
    raise SystemExit("Commit the intended source first; the transfer packages a clean committed tree.")
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=root, text=True).strip()
if branch != "dev/longball-m0-journey":
    raise SystemExit("Review the intended development branch before packaging this handoff.")
source = subprocess.check_output(["git", "archive", "--format=zip", "HEAD"], cwd=root)
history = root / ".local/longball-history.bundle"
subprocess.run(["git", "bundle", "create", str(history), branch], cwd=root, check=True)
output = root / ".local/longball-local-codex.zip"
export_hashes = {}
with ZipFile(output, "w", compression=ZIP_DEFLATED) as package:
    with ZipFile(io.BytesIO(source)) as archive:
        for member in archive.infolist():
            if not member.is_dir():
                package.writestr("LongBall/" + member.filename, archive.read(member))
    for file in sorted(export.rglob("*")):
        if file.is_symlink():
            raise SystemExit("Refusing a symlink in the browser export.")
        if file.is_file():
            relative = file.relative_to(root).as_posix()
            export_hashes[relative] = hashlib.sha256(file.read_bytes()).hexdigest()
            package.write(file, "LongBall/" + relative)
    package.write(history, "longball-history.bundle")
    package.writestr("transfer-build.json", json.dumps({
        "source_commit": commit, "branch": branch, "synthetic_only": True,
        "export_sha256": export_hashes,
        "native_device_proof": False, "hosted_deployment": False,
    }, indent=2) + "\n")
    package.writestr("START-HERE.txt", (
        "LongBall local Codex continuation\n\n"
        "Extract into a NEW empty folder. Preserve the existing LongBall project.\n"
        "Open the included LongBall folder in Codex and run in the LOCAL Windows environment.\n"
        "Paste Codex-local-prompt.txt to continue the same implementation.\n\n"
        "For a prebuilt review, open a terminal in LongBall and run:\n"
        "py -m http.server 4173 --bind 127.0.0.1 --directory apps/mobile/dist-web\n"
        "Then open http://127.0.0.1:4173/ on THAT computer. Keep the terminal running.\n"
        "If py is unavailable, let local Codex establish the installed runtime first.\n\n"
        "Source, native targets and full agreed scope are included. No account, host or paid\n"
        "resource is provisioned. The browser has independent fictional data only.\n"
        "The offline history bundle can restore the exact development branch; see\n"
        "LongBall/docs/development/local-review-windows.md for its clone command.\n"
    ))
    package.writestr("Codex-local-prompt.txt", (
        "Continue LongBall from the included committed source and tested browser export.\n"
        "Run locally on this Windows computer; do not attach the Linux cloud environment.\n"
        "Read README.md, any AGENTS.md, docs/development/local-review-windows.md,\n"
        "docs/development/review.md and the canonical build pack before changes.\n"
        "Preserve existing local files and work on dev/longball-m0-journey. If Git history is\n"
        "needed, restore the adjacent bundle into a new empty folder; never reset existing work.\n"
        "First inspect installed Python/Node tools and start the included static browser\n"
        "export on this PC's loopback port4173. Verify HTTP, JavaScript assets and Matchday\n"
        "rendering before opening the same URL in Codex's browser. Keep the server running\n"
        "during user review. Do not call a cloud-only check a desktop preview.\n"
        "Keep Expo/React Native iPhone and Android targets, shared domain logic, approved\n"
        "visuals, fictional Roma U10 data and the full F01-F28 scope. Do not move to Sites,\n"
        "provision paid services, publish, or onboard real children. Native physical proof,\n"
        "backend identity/sync and unresolved decisions remain open as documented.\n"
    ))
print(output)
