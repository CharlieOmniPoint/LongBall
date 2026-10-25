"""Exercise invitation, application sign-in rules and device wire boundaries."""
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

# Application policy is safe public metadata; only authenticated Super Admin
# operations may update it. Actual current-grant authorization is tested at HTTP
# and restricted PostgreSQL boundaries, rather than inferred from this schema.
rules = {
    'username': {'minLength': 3, 'maxLength': 40, 'allowNumbers': True, 'allowSeparators': True},
    'password': {'minLength': 12, 'requireUppercase': True, 'requireLowercase': True,
                 'requireNumber': True, 'requireSymbol': True, 'disallowUsername': True},
    'spectatorPin': {'blockSimpleCodes': True},
}
policy_checks = 0


def policy_valid(name, value, expected=True):
    global policy_checks
    assert valid(name, value) is expected, (name, value)
    policy_checks += 1


for name, fields in [('SignInRules', rules), ('UsernameSignInRules', rules['username']),
                     ('PasswordSignInRules', rules['password']),
                     ('SpectatorPinSignInRules', rules['spectatorPin'])]:
    policy_valid(name, fields)
    for field in fields:
        policy_valid(name, {key: value for key, value in fields.items() if key != field}, False)
    policy_valid(name, {**fields, 'accountId': 'caller-supplied-authority'}, False)
    policy_valid(name, None, False)

for minimum, maximum in [(3, 8), (3, 40), (8, 8), (32, 32), (32, 40)]:
    policy_valid('UsernameSignInRules', {**rules['username'], 'minLength': minimum, 'maxLength': maximum})
for patch in [{'minLength': 2}, {'minLength': 33}, {'minLength': 3.5}, {'minLength': '3'},
              {'minLength': None}, {'maxLength': 7}, {'maxLength': 41}, {'maxLength': 8.5},
              {'maxLength': '40'}, {'minLength': 32, 'maxLength': 31},
              {'minLength': 15, 'maxLength': 8}, {'pattern': '.*'}]:
    policy_valid('UsernameSignInRules', {**rules['username'], **patch}, False)
for minimum in [8, 64]:
    policy_valid('PasswordSignInRules', {**rules['password'], 'minLength': minimum})
for patch in [{'minLength': 7}, {'minLength': 65}, {'minLength': 12.5},
              {'minLength': '12'}, {'minLength': None}, {'maxLength': 999}]:
    policy_valid('PasswordSignInRules', {**rules['password'], **patch}, False)
for name, template, fields in [
    ('UsernameSignInRules', rules['username'], ['allowNumbers', 'allowSeparators']),
    ('PasswordSignInRules', rules['password'], ['requireUppercase', 'requireLowercase', 'requireNumber', 'requireSymbol', 'disallowUsername']),
    ('SpectatorPinSignInRules', rules['spectatorPin'], ['blockSimpleCodes']),
]:
    for field in fields:
        policy_valid(name, {**template, field: False})
        for wrong in [None, 0, 1, 'true']:
            policy_valid(name, {**template, field: wrong}, False)
policy_valid('SpectatorPinSignInRules', {'blockSimpleCodes': True, 'digits': 6}, False)

update = {'expectedRevision': 0, 'rules': rules}
policy_valid('SignInRulesInput', update)
policy_valid('SignInRulesInput', {**update, 'expectedRevision': 9007199254740991})
for patch in [{'expectedRevision': -1}, {'expectedRevision': 0.5}, {'expectedRevision': '0'},
              {'expectedRevision': True}, {'expectedRevision': 9007199254740992},
              {'rules': None}, {'actorAccountId': 'other'}, {'clubId': 'other'},
              {'role': 'super'}, {'provider': {'status': 'applied'}}]:
    policy_valid('SignInRulesInput', {**update, **patch}, False)
for absent in update:
    policy_valid('SignInRulesInput', {key: value for key, value in update.items() if key != absent}, False)

receipt = {'kind': 'sign-in-rules', 'revision': 0, 'rules': rules,
           'provider': {'status': 'not_configured', 'detail': 'The password provider is not connected.'}}
policy_valid('SignInRulesDto', receipt)
for status in ['applied', 'not_configured', 'pending']:
    policy_valid('SignInRulesDto', {**receipt, 'provider': {'status': status, 'detail': 'x' * 500}})
for patch in [{'kind': 'other'}, {'revision': -1}, {'revision': 1.5}, {'revision': '0'},
              {'revision': 9007199254740992}, {'provider': None},
              {'provider': {'status': 'unconfirmed', 'detail': ''}},
              {'provider': {'status': 'applied'}},
              {'provider': {'status': 'pending', 'detail': 'x' * 501}},
              {'provider': {'status': 'applied', 'detail': '', 'serviceSecret': 'hidden'}},
              {'username': 'private'}, {'salt': 'private'}, {'hash': 'private'},
              {'accountId': 'private'}, {'password': 'private'}]:
    policy_valid('SignInRulesDto', {**receipt, **patch}, False)
for absent in receipt:
    policy_valid('SignInRulesDto', {key: value for key, value in receipt.items() if key != absent}, False)

public_policy = contract['paths']['/sign-in-rules']['get']
admin_policy = contract['paths']['/administration/sign-in-rules']
assert contract['security'] == [{'bearerAuth': []}]
assert public_policy['security'] == []
assert 'requestBody' not in public_policy
for method in ['get', 'post']:
    operation = admin_policy[method]
    assert operation.get('security', contract['security']) == [{'bearerAuth': []}]
    assert 'Super Admin' in operation.get('summary', '') + operation.get('description', '')
    assert operation['responses']['200']['content']['application/json']['schema']['$ref'] == '#/components/schemas/SignInRulesDto'
assert public_policy['responses']['200']['content']['application/json']['schema']['$ref'] == '#/components/schemas/SignInRulesDto'
save_policy = admin_policy['post']
assert save_policy['requestBody']['required'] is True
assert save_policy['requestBody']['content']['application/json']['schema']['$ref'] == '#/components/schemas/SignInRulesInput'
refs = {parameter.get('$ref') for parameter in save_policy['parameters']}
assert '#/components/parameters/ContractVersion' in refs
assert '#/components/parameters/IdempotencyKey' in refs
assert all(parameter.get('name') not in ['accountId', 'clubId', 'teamId', 'role'] for parameter in save_policy['parameters'])
assert {'400', '401', '404', '409', '503'} <= set(save_policy['responses'])
policy_checks += 12

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
print(f'Identity contract credential, replay, destination, own-device and authority boundary cases passed; {policy_checks} application sign-in rule cases passed')
