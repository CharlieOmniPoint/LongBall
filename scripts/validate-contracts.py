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
runtime_contract = root.parents[1] / 'apps/api/contracts/runtime.openapi.yaml'
class UniqueRuntimeLoader(yaml.SafeLoader):
    """Reject accidentally overwritten keys in the maintained extension."""


def unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f'Duplicate runtime contract key: {key}')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueRuntimeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)
validate(yaml.load(runtime_contract.read_text(), Loader=UniqueRuntimeLoader))
print('Runtime extension OpenAPI 3.1 validation passed')
