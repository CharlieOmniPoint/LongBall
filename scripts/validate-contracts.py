"""Validate unchanged handover artifacts and the complete OpenAPI document."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import zipfile

import yaml
from openapi_spec_validator import validate

root = Path(__file__).resolve().parents[1] / 'docs' / 'longball'
archive = root.parents[1] / 'LongBall_Mobile_Build_Pack_v0_1.zip'
with zipfile.ZipFile(archive) as supplied:
    for name in supplied.namelist():
        assert (root / name).read_bytes() == supplied.read(name), name
    print(f'Preserved all {len(supplied.namelist())} supplied archive members', flush=True)
checksums = json.loads((root / 'checks/SHA256SUMS.json').read_text())
for name, expected in checksums.items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
print(f'Passed {len(checksums)} archived checksums', flush=True)
subprocess.run(
    [sys.executable, str(root / 'checks/validate_spec_artifacts.py'), str(root)],
    check=True,
)
validate(yaml.safe_load((root / 'contracts/openapi.yaml').read_text()))
print('Full OpenAPI 3.1 validation passed')
