"""Check DS14/SEC17 wire privacy, CAS, exact command and canonical acknowledgement boundaries."""
from copy import deepcopy
from pathlib import Path
import jsonschema
import yaml

root = Path(__file__).resolve().parents[1]
contract = yaml.safe_load((root / 'apps/api/contracts/runtime.openapi.yaml').read_text())
canonical = yaml.safe_load((root / 'docs/longball/contracts/openapi.yaml').read_text())


def valid(name, value):
    schema = {'components': contract['components'], '$ref': f'#/components/schemas/{name}'}
    return jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).is_valid(value)


def parameters(path, method):
    return {item['$ref'].split('/')[-1] for item in contract['paths'][path].get('parameters', []) + contract['paths'][path][method].get('parameters', [])}


push = {'deviceId': 'native-phone-1', 'platform': 'ios', 'transport': 'apns', 'token': 'fictional-destination-' + 'a' * 32, 'appBuild': 'fictional-review', 'permission': 'granted'}
assert valid('PushRegistrationInput', push)
assert valid('PushRegistrationInput', {**push, 'permission': 'denied'})  # Service409; use withdrawal.
assert set(contract['components']['schemas']['PushRegistrationInput']['required']) == set(canonical['components']['schemas']['PushRegistration']['required'])
for patch in [{'accountId': 'another'}, {'issuer': 'another'}, {'revision': 1}, {'deviceId': 'a' * 121}, {'platform': 'web'}, {'transport': 'arbitrary'}, {'token': 'short'}, {'token': 'x' * 4097}, {'token': push['token'] + '\n'}, {'token': push['token'] + ' '}, {'appBuild': 'build\n'}, {'appBuild': 'a' * 61}]:
    assert not valid('PushRegistrationInput', {**push, **patch}), tuple(patch)

instant = '2026-10-21T12:00:00Z'
device = {'deviceId': 'native-phone-1', 'platform': 'ios', 'transport': 'apns', 'permission': 'granted', 'state': 'registered', 'revision': 1, 'appBuild': 'fictional-review', 'registeredAt': instant, 'updatedAt': instant, 'revokedAt': None, 'lastOperationId': 'operation-1'}
status = {'accountId': 'own-account', 'registrationConfigured': True, 'deliveryConfigured': False, 'platforms': {'ios': {'transport': 'apns', 'providerConfigId': 'explicit-processor'}}, 'devices': [device]}
assert valid('AccountPushStatus', status)
revoked = {**device, 'transport': None, 'permission': 'denied', 'state': 'revoked', 'revision': 2, 'registeredAt': None, 'revokedAt': instant}
assert valid('AccountPushStatus', {**status, 'registrationConfigured': False, 'platforms': {}, 'devices': [revoked]})
assert valid('AccountPushStatus', {**status, 'platforms': {'android': {'transport': 'expo', 'providerConfigId': 'approved-expo', 'projectId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}}})
for patch in [{'token': push['token']}, {'tokenHash': 'a' * 64}, {'ciphertext': 'private'}, {'issuer': 'private'}, {'providerConfigId': 'private'}, {'permission': 'denied'}, {'registeredAt': None}, {'revokedAt': instant}, {'revision': 0}]:
    assert not valid('AccountPushStatus', {**status, 'devices': [{**device, **patch}]}), tuple(patch)
for patch in [{'keyring': 'private'}, {'token': push['token']}, {'devices': [device, device]}, {'platforms': {'ios': {'transport': 'fcm', 'providerConfigId': 'wrong-platform'}}}, {'platforms': {'ios': {'transport': 'apns', 'providerConfigId': 'config', 'projectId': 'extra'}}}, {'platforms': {'android': {'transport': 'expo', 'providerConfigId': 'missing-project'}}}]:
    assert not valid('AccountPushStatus', {**status, **patch}), tuple(patch)

registration = contract['paths']['/me/push-registrations']['post']
withdrawal = contract['paths']['/me/push-registrations/{deviceId}']['delete']
for path, method in [('/me/push-registrations', 'post'), ('/me/push-registrations/{deviceId}', 'delete')]:
    assert {'ContractVersion', 'IdempotencyKey', 'PushIfMatch'} <= parameters(path, method)
    assert 'security' not in contract['paths'][path][method]  # Inherits verified bearer.
    assert {'400', '401', '404', '409', '428'} <= set(contract['paths'][path][method]['responses'])
assert 'PushIfMatch' not in parameters('/me/push-registrations', 'get')
assert '201' not in registration['responses'] and '200' in registration['responses']
assert '204' not in withdrawal['responses'] and '202' in withdrawal['responses']
revision = contract['components']['parameters']['PushIfMatch']
assert revision['required'] is True and revision['name'] == 'If-Match'
for value in ['"0"', '"1"', '"999999999999999"']:
    assert jsonschema.Draft202012Validator(revision['schema']).is_valid(value)
for value in ['0', '"01"', '*', 'W/"1"', '"1","2"', '"-1"', '"1000000000000000"', '"1"\n', 0]:
    assert not jsonschema.Draft202012Validator(revision['schema']).is_valid(value)
for runtime, supplied in [('PushRegistrationMutationResult', 'MutationResult'), ('PushRegistrationWithdrawalAccepted', 'Accepted')]:
    assert set(contract['components']['schemas'][runtime]['required']) == set(canonical['components']['schemas'][supplied]['required'])
    assert set(contract['components']['schemas'][runtime]['properties']) == set(canonical['components']['schemas'][supplied]['properties'])
assert valid('PushRegistrationMutationResult', {'id': 'device-1', 'revision': 1, 'serverTime': instant})
assert valid('PushRegistrationWithdrawalAccepted', {'operationId': 'operation-1', 'status': 'completed', 'serverTime': instant})
assert not valid('PushRegistrationWithdrawalAccepted', {'operationId': 'operation-1', 'status': 'pending', 'serverTime': instant})

own = {'kind': 'own-team-privileges', 'teamId': 'roma', 'seasonId': '2026-27', 'uploadsAllowed': True, 'invitationsAllowed': False}
assert valid('OwnTeamPrivileges', own)
for patch in [{'revision': 0}, {'reasonCode': 'private'}, {'privateNote': 'private'}, {'targets': []}]:
    assert not valid('OwnTeamPrivileges', {**own, **patch}), tuple(patch)
manager = {'kind': 'team-privileges', 'teamId': 'roma', 'seasonId': '2026-27', 'revision': 0, 'own': own, 'targets': [{'accountId': 'player-1', 'label': 'Fictional Player', 'uploadsSuspended': False, 'invitationsSuspended': True}]}
assert valid('TeamPrivilegesView', manager)
private = deepcopy(manager)
private['targets'][0]['privateNote'] = 'private'
assert not valid('TeamPrivilegesView', private)
command = {'id': 'decision-1', 'type': 'privilege.suspended', 'expectedRevision': 0, 'targetAccountId': 'player-1', 'privilege': 'uploads', 'reasonCode': 'review.pending', 'confirm': True}
assert valid('TeamPrivilegeRequest', {'command': command})
for note in [None, '', 'Private note\twith permitted\nline breaks\r']:
    assert valid('TeamPrivilegeRequest', {'command': {**command, 'privateNote': note}})
for patch in [{'confirm': False}, {'expectedRevision': -1}, {'expectedRevision': 0.5}, {'expectedRevision': 9007199254740992}, {'privilege': 'all-access'}, {'targetAccountId': ''}, {'reasonCode': 'not an operational code'}, {'reasonCode': 'a' * 81}, {'privateNote': 'a' * 1001}, {'privateNote': 'bad\x00note'}, {'privateNote': 'bad\x0bnote'}, {'seasonId': 'other'}, {'approve': True}]:
    assert not valid('TeamPrivilegeRequest', {'command': {**command, **patch}}), tuple(patch)
assert not valid('TeamPrivilegeRequest', {'command': command, 'teamId': 'other'})
receipt = {'kind': 'team-privilege-receipt', 'commandId': 'decision-1', 'teamId': 'roma', 'revision': 1}
assert valid('TeamPrivilegeReceipt', receipt)
assert not valid('TeamPrivilegeReceipt', {**receipt, 'privateNote': 'private'})
assert {'ContractVersion', 'IdempotencyKey'} <= parameters('/teams/{teamId}/privileges', 'post')
assert 'PushIfMatch' not in parameters('/teams/{teamId}/privileges', 'post')
assert contract['components']['parameters']['SelectedRole'].get('required', False) is False
assert contract['components']['parameters']['ContractVersion']['schema']['const'] == 'longball.events/1.1'
print('DS14/SEC17 strict metadata privacy, canonical receipts, quoted zero-generation CAS, optional selected role and explicit privilege decision cases passed')
