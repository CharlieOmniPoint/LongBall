"""Exercise the maintained logo wire boundary; no deployment or services."""
from pathlib import Path
from copy import deepcopy
import jsonschema
import yaml

root = Path(__file__).resolve().parents[1]
contract = yaml.safe_load((root / 'apps/api/contracts/runtime.openapi.yaml').read_text())


def valid(name, value):
    schema = {'components': contract['components'], '$ref': f'#/components/schemas/{name}'}
    return not list(jsonschema.Draft202012Validator(schema).iter_errors(value))


prepare = {'kind': 'team_logo', 'teamId': 'roma', 'byteSize': 1024, 'mimeType': 'image/png', 'sha256': 'a' * 64, 'policyAcknowledged': True}
assert valid('LogoPrepareInput', prepare)
assert valid('LogoPrepareInput', {**prepare, 'mimeType': 'image/heic'})
club = {**prepare, 'kind': 'club_logo', 'clubId': 'rovers'}
del club['teamId']
assert valid('LogoPrepareInput', club)
for patch in [{'seasonId': '26'}, {'matchId': 'fake-game'}, {'clubId': 'invented-club'}, {'ownerId': 'other'}, {'requestId': 'body-request'}, {'mimeType': 'image/heif'}, {'byteSize': 15728641}, {'policyAcknowledged': False}]:
    assert not valid('LogoPrepareInput', {**prepare, **patch}), patch

publish = {'command': {'id': 'command-1', 'type': 'logo.published', 'kind': 'team_logo', 'assetId': 'asset-1', 'reviewedRevision': 2, 'expectedSlotVersion': 3, 'confirmRightsToUse': True, 'policyVersion': 'logo-rights-v1'}}
assert valid('BrandPublishRequest', publish)
for patch in [{'confirmRightsToUse': False}, {'reviewedRevision': 0}, {'expectedSlotVersion': -1}, {'kind': 'game_photo'}, {'seasonId': '26'}, {'actorId': 'manager'}]:
    assert not valid('BrandPublishRequest', {'command': {**publish['command'], **patch}}), patch
remove = {'command': {'id': 'command-2', 'type': 'logo.removed', 'kind': 'team_logo', 'expectedSlotVersion': 3}}
assert valid('BrandRemoveRequest', remove)
assert not valid('BrandPublishRequest', remove)
assert not valid('BrandRemoveRequest', {'command': {**remove['command'], 'assetId': 'old-asset'}})

reference = {'assetId': 'asset-1', 'revision': 2, 'kind': 'club_logo', 'clubId': 'rovers', 'teamId': None}
assert valid('BrandReference', reference)
assert not valid('BrandReference', {**reference, 'teamId': 'roma'})
assert not valid('BrandReference', {**reference, 'kind': 'team_logo'})
assert valid('BrandReference', {**reference, 'kind': 'team_logo', 'teamId': 'roma'})

dto = {'kind': 'team-branding', 'teamId': 'roma', 'clubId': 'rovers', 'authoritySeasonId': '26', 'policyVersion': 'logo-rights-v1', 'club': {'id': 'rovers', 'name': 'Rovers', 'slotVersion': 2, 'logo': reference}, 'team': {'id': 'roma', 'name': 'Roma', 'ageGroup': 'U10', 'slotVersion': 0, 'logo': None}, 'effective': {'source': 'club', 'logo': reference}, 'canWriteClub': True, 'canWriteTeam': False, 'assets': []}
assert valid('BrandingDto', dto)
private = deepcopy(dto)
private['ownerId'] = 'other'
assert not valid('BrandingDto', private)
prepared = {'kind': 'prepared-logo-upload', 'uploadId': 'upload-1', 'asset': reference, 'uploadToken': 'A' * 43, 'expiresAtMs': 1800000000000, 'maxBytes': 15728640}
assert valid('PreparedLogoUpload', prepared)
assert not valid('PreparedLogoUpload', {**prepared, 'ownerId': 'other'})
assert not valid('PreparedLogoUpload', {**prepared, 'originalKey': 'private/quarantine/file'})
assert not valid('PreparedLogoUpload', {**prepared, 'uploadToken': 'short'})
processed = {'kind': 'processed-logo-upload', 'uploadId': 'upload-1', 'asset': reference, 'status': 'processed', 'width': 1024, 'height': 768}
assert valid('ProcessedLogoUpload', processed)
for patch in [{'scannerEngine': 'private'}, {'originalKey': 'private'}, {'status': 'published'}, {'width': 0}, {'height': 1025}]:
    assert not valid('ProcessedLogoUpload', {**processed, **patch}), patch
assert valid('UploadedLogoReceipt', {'uploadId': 'upload-1', 'status': 'uploaded', 'byteSize': 1024})
assert not valid('UploadedLogoReceipt', {'uploadId': 'upload-1', 'status': 'processed', 'byteSize': 1024})
receipt = {'kind': 'branding-command-receipt', 'commandId': 'command-1', 'revision': 3, 'acceptedAt': '2026-10-21T15:00:00Z', 'branding': dto}
assert valid('BrandingCommandReceipt', receipt)
assert not valid('BrandingCommandReceipt', {**receipt, 'revision': 0})
assert not valid('BrandingCommandReceipt', {**receipt, 'controllerToken': 'private'})
for path, operations in contract['paths'].items():
    if '/branding' not in path:
        continue
    for method in ('post', 'put'):
        if method not in operations:
            continue
        refs = {parameter.get('$ref') for parameter in operations.get('parameters', []) + operations[method].get('parameters', [])}
        assert '#/components/parameters/BrandWriteRole' in refs, path
        assert '#/components/parameters/IdempotencyKey' in refs, path
assert contract['components']['parameters']['BrandWriteRole']['required'] is True
assert tuple(map(int, contract['info']['version'].split('.'))) >= (1, 3, 0)
assert len([path for path in contract['paths'] if '/branding' in path]) == 7
print('Logo contract positive/negative ancestry, reviewed-version, rights, action and DTO cases passed')
