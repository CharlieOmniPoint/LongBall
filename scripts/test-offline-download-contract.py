"""DS10 snapshot-version/integrity metadata and API04 pagination wire boundaries."""
from copy import deepcopy
from pathlib import Path
import jsonschema
import yaml

root = Path(__file__).resolve().parents[1]
contract = yaml.safe_load((root / 'apps/api/contracts/runtime.openapi.yaml').read_text())
canonical = yaml.safe_load((root / 'docs/longball/contracts/openapi.yaml').read_text())


def valid(name, value):
    return jsonschema.Draft202012Validator(
        {'components': contract['components'], '$ref': f'#/components/schemas/{name}'},
        format_checker=jsonschema.FormatChecker(),
    ).is_valid(value)


instant = '2026-10-21T12:00:00.000Z'
projection = {
    'config': {'matchId': 'fixture-1', 'players': [{'id': 'player-1', 'displayName': 'Player One', 'goalkeeperChoice': 0, 'available': True}], 'selectedPlayerIds': ['player-1'], 'pitchPlaces': 7, 'plannedHalfDurationMs': 1500000, 'fixedKeeperId': None},
    'status': 'preparation', 'revision': 0, 'attendance': {'player-1': 'not_recorded'}, 'availability': {'player-1': True},
    'stagedLineup': [], 'lineup': [], 'half': 0, 'halfActiveMs': 0, 'matchActiveMs': 0, 'firstHalfDurationMs': None,
    'anchor': None, 'recoveryRequired': False, 'intervals': [], 'targetIntervals': [], 'score': {'for': 0, 'against': 0},
    'halfTimeScore': None, 'completedAtMs': None, 'completedTimeQuality': None, 'recoveryReason': None, 'appliedEvents': {},
}
publication = {'fixtureClass': None, 'classificationVersion': None, 'resultPolicy': None, 'sharingPolicy': {'version': 'unapproved', 'approvedBy': None, 'approvedAt': None, 'shareScores': False, 'shareDerivedResults': False}}
bundle = {
    'contractVersion': 'longball.events/1.1', 'schemaVersion': 1, 'engineVersion': 'synthetic-live-4',
    'bundleId': 'bundle-1', 'snapshotSchemaVersion': 1, 'checksumSerialization': 'longball.canonical-json/1', 'checksumSha256': 'a' * 64,
    'matchId': 'fixture-1', 'teamId': 'team-1', 'seasonId': 'season-1', 'deviceId': 'phone-1',
    'state': projection, 'acceptedRevision': 0, 'deviceCheckpoint': {'clientSequence': 0, 'previousEventId': None},
    'controller': None, 'publication': publication, 'acceptedEvents': [], 'controllerTransitions': [], 'downloadedAt': instant,
    'clockAnchor': {'serverTime': instant, 'quality': 'observation_only', 'continuousMappingEstablished': False}, 'syntheticOnly': True,
}
assert valid('VerifiedMatchSnapshot', bundle)
for key in ['checksumSha256', 'checksumSerialization', 'snapshotSchemaVersion', 'publication', 'acceptedEvents', 'controllerTransitions', 'deviceId']:
    candidate = deepcopy(bundle)
    del candidate[key]
    assert not valid('VerifiedMatchSnapshot', candidate), key
for patch in [{'snapshotSchemaVersion': 2}, {'checksumSha256': 'A' * 64}, {'clockAnchor': {'serverTime': instant, 'quality': 'trusted', 'continuousMappingEstablished': True}}, {'controllerToken': 'never-response-data'}, {'publication': {}}]:
    assert not valid('VerifiedMatchSnapshot', {**bundle, **patch}), patch.keys()
for field in ['birthDate', 'parentEmail', 'contactDetails']:
    candidate = deepcopy(bundle)
    candidate['state']['config']['players'][0][field] = 'private'
    assert not valid('VerifiedMatchSnapshot', candidate), field
candidate = deepcopy(bundle)
candidate['controller'] = {'epoch': 1, 'account_id': 'manager-1', 'device_id': 'phone-1', 'frozen': 0, 'controllerToken': 'private-capability'}
assert not valid('VerifiedMatchSnapshot', candidate)
offline = contract['paths']['/matches/{matchId}/offline-bundle']
assert '#/components/parameters/ControllerToken' in [item.get('$ref') for item in offline['parameters']]
assert '409' in offline['get']['responses'] and '422' in offline['get']['responses']
observation = contract['paths']['/matches/{matchId}/download']
assert '#/components/parameters/ControllerToken' not in [item.get('$ref') for item in observation['parameters']]
assert contract['components']['schemas']['VerifiedMatchSnapshot']['properties']['acceptedEvents']['maxItems'] == canonical['components']['schemas']['OfflineBundle']['properties']['acceptedEvents']['maxItems'] == 10000
assert valid('CurrentMatchPage', {'items': [], 'nextCursor': None, 'serverTime': instant})
assert valid('CurrentMatchPage', {'items': [{}], 'nextCursor': 'opaque', 'serverTime': instant})
for value in [{'items': [], 'serverTime': instant}, {'items': [], 'nextCursor': None, 'serverTime': 'invalid'}, {'items': [], 'nextCursor': None, 'serverTime': instant, 'totalPrivateMatches': 5}]:
    assert not valid('CurrentMatchPage', value)
listing = contract['paths']['/teams/{teamId}/matches']['get']
limit = next(item['schema'] for item in listing['parameters'] if item['name'] == 'limit')
assert limit == {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 25}
print('DS10 versioned snapshot integrity/privacy metadata and API04 typed-pagination boundaries passed')
