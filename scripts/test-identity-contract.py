"""Exercise invitation/device wire scopes without storing capabilities or provisioning services."""
from pathlib import Path
from copy import deepcopy
import jsonschema
import yaml

root = Path(__file__).resolve().parents[1]
contract = yaml.safe_load((root / 'apps/api/contracts/runtime.openapi.yaml').read_text())


def valid(name, value):
    schema = {'components': contract['components'], '$ref': f'#/components/schemas/{name}'}
    return not list(jsonschema.Draft202012Validator(schema).iter_errors(value))


token = 'A' * 43
assert valid('InvitationTokenInput', {'token': token})
for value in [{'token': 'a' * 64}, {'token': token, 'tokenHash': 'a' * 64}, {'token': token, 'teamId': 'other'}, {'token': token[:-1] + 'B'}, {'token': token + '\n'}]:
    assert not valid('InvitationTokenInput', value), value.keys()

write = {'seasonId': '2026-27', 'expiresInHours': 1}
assert valid('InvitationWrite', write)
for patch in [{'expiresInHours': 0}, {'expiresInHours': 49}, {'expiresInHours': 1.5}, {'reviewCode': 'client-code'}, {'tokenHash': 'a' * 64}, {'inviterAccountId': 'other'}]:
    assert not valid('InvitationWrite', {**write, **patch}), patch.keys()
assert not valid('InvitationWrite', {'seasonId': '2026-27'})

redacted = {'id': 'invite-1', 'expiresAt': '2026-10-21T15:00:00Z', 'teamId': 'roma', 'seasonId': '2026-27', 'credentialAvailable': False, 'requiresReissue': True}
assert valid('RedactedInvitationReceipt', redacted)
for patch in [{'shareUrl': 'https://example.invalid/#secret'}, {'tokenHash': 'a' * 64}, {'credentialAvailable': True}, {'requiresReissue': False}]:
    assert not valid('RedactedInvitationReceipt', {**redacted, **patch}), patch.keys()
destination = {'invitationId': 'invite-1', 'teamId': 'roma', 'seasonId': '2026-27', 'expiresAt': '2026-10-21T15:00:00Z'}
assert valid('InvitationDestination', destination)
assert not valid('InvitationDestination', {**destination, 'id': 'alias'})
assert not valid('InvitationDestination', {**destination, 'grantAccountId': 'other'})
for path in ['/spectator-invites/inspect', '/spectator-invites/accept']:
    assert 'security' not in contract['paths'][path]['post']  # Inherits required bearer authentication.
for path in ['/spectator-invites/activation-info', '/spectator-invites/activate']:
    assert contract['paths'][path]['post']['security'] == []
inspect = contract['paths']['/spectator-invites/inspect']['post']
assert not any('IdempotencyKey' in parameter.get('$ref', '') for parameter in inspect['parameters'])

native = {'deviceId': 'native-installation-1', 'platform': 'ios'}
assert valid('NativeDeviceInput', native)
for patch in [{'accountId': 'other'}, {'issuer': 'other'}, {'registeredAt': '2026-10-21T15:00:00Z'}, {'platformVerified': True}, {'platform': 'web'}]:
    assert not valid('NativeDeviceInput', {**native, **patch}), patch.keys()
device = {'deviceId': 'native-installation-1', 'source': 'native_app_enrolment', 'label': None, 'platform': 'ios', 'platformVerified': False, 'registeredAt': '2026-10-21T15:00:00Z', 'lastSeenAt': '2026-10-21T15:00:00Z'}
dto = {'kind': 'recognised-devices', 'accountId': 'own-account', 'asOf': '2026-10-21T15:00:00Z', 'devices': [device], 'remoteRevocationAvailable': False}
assert valid('RecognisedDevices', dto)
legacy = deepcopy(dto)
legacy['devices'][0].update(source='match_controller_enrolment', platform=None, registeredAt=None, lastSeenAt=None)
assert valid('RecognisedDevices', legacy)
for patch in [{'platformVerified': True}, {'pushToken': 'private'}, {'controllerToken': 'private'}, {'accountId': 'other'}]:
    private = deepcopy(dto)
    private['devices'][0].update(patch)
    assert not valid('RecognisedDevices', private), patch.keys()
assert not valid('RecognisedDevices', {**dto, 'remoteRevocationAvailable': True})
print('Identity contract credential, replay, destination, own-device and authority boundary cases passed')
