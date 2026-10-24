"""Check new scoped club, spectator, team-document and opposition wire boundaries.

This validates contract cases, not server authority, PDF parsing, audio playback,
SMTP delivery or physical-device acceptance; their real suites are separate.
"""
from copy import deepcopy
from pathlib import Path
import jsonschema
import yaml

root = Path(__file__).resolve().parents[1]
contract = yaml.safe_load((root / 'apps/api/contracts/runtime.openapi.yaml').read_text())
checks = 0


def accepted(name, value, expected=True):
    global checks
    schema = {'components': contract['components'], '$ref': f'#/components/schemas/{name}'}
    actual = not list(jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).iter_errors(value))
    assert actual == expected, (name, 'expected valid' if expected else 'expected invalid')
    checks += 1


def denied(name, value):
    accepted(name, value, False)


# Authority is server-owned. Wire commands cannot choose child/adult proof or scope.
accepted('ClubAdministrationCommand', {'type': 'club.create', 'name': 'Northfield Juniors'})
team = {'type': 'team.create', 'clubId': 'club-one', 'name': 'Falcons', 'ageGroup': 'U10', 'format': 7, 'seasonStartYear': 2026}
accepted('ClubAdministrationCommand', team)
for patch in [{'ageGroup': 'U4'}, {'ageGroup': 'U22'}, {'format': 12}, {'format': 4}, {'format': 7.5}, {'seasonStartYear': 1999}, {'seasonStartYear': 2101}, {'adultVerified': True}, {'role': 'super'}, {'name': '   '}]:
    denied('ClubAdministrationCommand', {**team, **patch})
for operation in ['administrator.grant', 'administrator.revoke']:
    for level, club in [('super', None), ('club', 'club-one')]:
        accepted('ClubAdministrationCommand', {'type': operation, 'accountId': 'adult-one', 'level': level, 'clubId': club})
    denied('ClubAdministrationCommand', {'type': operation, 'accountId': 'adult-one', 'level': 'super', 'clubId': 'club-one'})
    denied('ClubAdministrationCommand', {'type': operation, 'accountId': 'adult-one', 'level': 'club', 'clubId': None})
denied('ClubAdministrationInput', {'command': team, 'principal': {'administration': {'level': 'super', 'clubIds': []}}})

# No user/session/team claim can be attached to an invitation-backed PIN registration.
token = 'A' * 43  # Format-only test value; this is no issued credential.
registration = {'token': token, 'username': 'review.guest', 'passcode': '4836', 'requestId': 'register-one'}
accepted('SpectatorRegistrationInput', registration)
for pin in ['1111', '0000', '1234', '4321', '7890', '9012', '0987', '1212', '1122', '2580', '2001', '0852', '123', '12345', 'abcd', '１２３４', '١٢٣٤']:
    denied('SpectatorRegistrationInput', {**registration, 'passcode': pin})
for pin in ['4836', '7942', '6309', '0486']:
    accepted('SpectatorRegistrationInput', {**registration, 'passcode': pin})
for patch in [{'role': 'manager'}, {'clubId': 'other-club'}, {'teamId': 'other-team'}, {'accountId': 'someone-else'}, {'verifier': 'caller-value'}, {'salt': 'caller-value'}]:
    denied('SpectatorRegistrationInput', {**registration, **patch})
denied('SpectatorRegistrationInput', {key: value for key, value in registration.items() if key != 'token'})
denied('SpectatorRegistrationInput', {**registration, 'token': token + '\n'})
accepted('SpectatorLoginInput', {'username': 'review.guest', 'passcode': '4836'})
denied('SpectatorLoginInput', {'username': 'review.guest', 'passcode': '4836', 'role': 'manager'})

request = {'requestId': 'request-one', 'clubId': 'club-one', 'teamId': 'team-one', 'seasonId': 'season-one', 'requestedRole': 'spectator', 'name': 'Demo Adult', 'email': 'review@example.invalid'}
accepted('InviteRequestInput', request)
accepted('InviteRequestInput', {**request, 'requestedRole': 'player'})
for patch in [{'requestedRole': 'manager'}, {'requestedRole': 'administrator'}, {'requestedRole': 'super'}, {'name': ' '}, {'email': 'invalid'}, {'accepted': True}, {'status': 'handled'}]:
    denied('InviteRequestInput', {**request, **patch})
accepted('InviteRequestPending', {'requestId': 'request-one', 'status': 'pending'})
denied('InviteRequestPending', {'requestId': 'request-one', 'status': 'pending', 'accessToken': 'private'})
for status in ['handled', 'declined']:
    accepted('InviteRequestDecision', {'status': status})
for value in [{'status': 'approved'}, {'status': 'handled', 'role': 'spectator'}]:
    denied('InviteRequestDecision', value)

connection = {'players': [{'id': 'player-one', 'label': 'Sam Review'}], 'followedPlayerId': 'player-one'}
accepted('SpectatorConnections', connection)
accepted('SpectatorConnectionInput', {'playerId': None})
accepted('SpectatorConnectionInput', {'playerId': 'player-one'})
private = deepcopy(connection)
private['players'][0]['faPlayerId'] = '0000123'
denied('SpectatorConnections', private)
denied('SpectatorConnectionInput', {'playerId': 'player-one', 'teamId': 'another-team'})

# A private PDF is base64 in an authenticated JSON envelope, not a public URL.
sheet = {'id': 'document-command', 'expectedRevision': 0, 'type': 'team_sheet.uploaded', 'fileName': 'FA-Team.pdf', 'base64': 'JVBERi0xLjcK'}
accepted('TeamSheetCommand', sheet)
for patch in [{'fileName': '../FA.pdf'}, {'fileName': 'FA.exe'}, {'fileName': 'folder\\FA.pdf'}, {'expectedRevision': -1}, {'byteLength': 1}, {'base64': 'not-base64!'}, {'downloadUrl': 'https://example.invalid/private'}]:
    denied('TeamSheetCommand', {**sheet, **patch})
accepted('TeamSheetCommand', {'id': 'document-command', 'expectedRevision': 1, 'type': 'team_sheet.removed'})
metadata = {'fileName': 'FA-Team.pdf', 'byteLength': 9, 'sha256': 'a' * 64, 'updatedAtMs': 1000}
download = {'kind': 'team-document', 'teamId': 'team-one', 'revision': 1, 'document': metadata, 'base64': sheet['base64']}
accepted('TeamSheetDownload', download)
denied('TeamSheetDownload', {**download, 'document': None})
denied('TeamSheetMetadata', {**metadata, 'byteLength': 5242881})

review = {'id': 'opposition-command', 'type': 'opposition.review.saved', 'matchId': 'game-one', 'expectedRevision': 0, 'rating': 4, 'note': 'Good passing.'}
accepted('OppositionReviewCommand', review)
accepted('OppositionReviewCommand', {**review, 'note': '😀' * 256})
for patch in [{'rating': 0}, {'rating': 6}, {'rating': 1.5}, {'note': 'x' * 257}, {'note': '\u0000'}, {'accountId': 'other'}, {'playerId': 'other'}, {'audience': 'spectator'}]:
    denied('OppositionReviewCommand', {**review, **patch})
accepted('OwnFaIdCommand', {'id': 'own-fa-command', 'type': 'own.fa_id_saved', 'expectedRevision': 0, 'faPlayerId': '000123'})
accepted('OwnFaIdCommand', {'id': 'own-fa-command', 'type': 'own.fa_id_saved', 'expectedRevision': 0, 'faPlayerId': None})
for fa_id in [123, 'x', '1' * 21]:
    denied('OwnFaIdCommand', {'id': 'own-fa-command', 'type': 'own.fa_id_saved', 'expectedRevision': 0, 'faPlayerId': fa_id})
for settings in [{'enabled': True, 'leadSeconds': 60, 'volume': 0.7}, {'enabled': False, 'leadSeconds': 0, 'volume': 0}, {'enabled': True, 'leadSeconds': 300, 'volume': 1}]:
    accepted('SubstitutionAlertSettings', settings)
for patch in [{'leadSeconds': -1}, {'leadSeconds': 301}, {'leadSeconds': 1.5}, {'volume': 2}, {'volume': -0.1}, {'role': 'spectator'}]:
    denied('SubstitutionAlertSettings', {'enabled': True, 'leadSeconds': 60, 'volume': 0.7, **patch})

new_paths = ['/administration', '/clubs/{clubId}/reports', '/teams/{teamId}/team-sheet', '/teams/{teamId}/team-sheet/download', '/teams/{teamId}/opposition-reviews', '/spectator-access/preview', '/spectator-access/register', '/spectator-access/login', '/spectator-access/session', '/spectator-access/directory', '/spectator-access/requests', '/teams/{teamId}/invite-requests', '/teams/{teamId}/invite-requests/{requestId}/decision', '/teams/{teamId}/spectator-connections']
anonymous = {'/spectator-access/preview', '/spectator-access/register', '/spectator-access/login', '/spectator-access/directory', '/spectator-access/requests'}
assert contract['security'] == [{'bearerAuth': []}]
for path in new_paths:
    for method, operation in contract['paths'][path].items():
        if method not in ['get', 'post', 'delete']:
            continue
        assert (operation.get('security') == []) == (path in anonymous), (path, method)
        assert 'operationId' in operation
        checks += 1
        if method == 'post' and path not in anonymous:
            names = {item.get('$ref') for item in operation['parameters']}
            assert '#/components/parameters/ContractVersion' in names and '#/components/parameters/IdempotencyKey' in names
assert '201' in contract['paths']['/spectator-access/login']['post']['responses']
assert '202' in contract['paths']['/spectator-access/requests']['post']['responses']
assert '204' in contract['paths']['/spectator-access/session']['delete']['responses']
assert contract['paths']['/teams/{teamId}/spectator-connections']['parameters'][-1]['schema']['enum'] == ['spectator']
assert contract['paths']['/teams/{teamId}/opposition-reviews']['post']['parameters'][0]['schema']['enum'] == ['manager', 'administrator']
assert contract['paths']['/teams/{teamId}/invite-requests']['parameters'][-1]['schema']['enum'] == ['manager']
statistic = contract['components']['schemas']['PlayerStatisticRow']
for field in ['knownCleanSheets', 'goalkeepingReviewedMatches', 'goalkeepingUnknownMatches']:
    assert field in statistic['required'] and statistic['properties'][field]['minimum'] == 0
print(f'Club expansion contract: {checks} scoped payload/security/format boundary cases passed; server and device proofs remain separate.')
