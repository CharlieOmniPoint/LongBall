"""Package only the static synthetic browser export; never include local journals."""
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
source = root / "apps/mobile/dist-web"
if not (source / "index.html").is_file():
    raise SystemExit("Run pnpm build:web first.")
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip())
output = root / ".local/longball-browser-review.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED) as bundle:
    for file in sorted(source.rglob("*")):
        if file.is_symlink():
            raise SystemExit("Refusing a symbolic link in the browser export.")
        if file.is_file():
            bundle.write(file, "site/" + file.relative_to(source).as_posix())
    bundle.writestr("review-build.json", json.dumps({
        "commit": commit, "working_tree_modified": dirty,
        "purpose": "Fictional Roma U10 browser review; no backend or native security proof",
    }, indent=2) + "\n")
    bundle.writestr("README.txt", (
        "LongBall synthetic browser review\n\n"
        "Serve the site/ directory over HTTP locally or HTTPS for a later shared link.\n"
        "Example: python3 -m http.server 4173 --directory site\n"
        "Open http://localhost:4173 in the same machine's browser.\n\n"
        "Each browser keeps its own fictional match in IndexedDB. Data is not encrypted,\n"
        "shared, authenticated or backed up. Preserve the same origin to keep a rehearsal.\n"
        "Native iPhone/Android device proofs and the remaining pilot features are incomplete.\n"
    ))
print(output)
