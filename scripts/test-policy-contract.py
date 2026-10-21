"""Exercise the prospective EV05 runtime schema while preserving the supplied canonical contract."""
from pathlib import Path
import jsonschema
import yaml

root = Path(__file__).resolve().parents[1]
contract = yaml.safe_load((root / 'apps/api/contracts/runtime.openapi.yaml').read_text())
canonical = yaml.safe_load((root / 'docs/longball/contracts/openapi.yaml').read_text())

def valid(name, value):
    schema = {'components': contract['components'], '$ref': f'#/components/schemas/{name}'}
    return not list(jsonschema.Draft202012Validator(schema).iter_errors(value))

payload = {'keeperMode': 'sole_fixed', 'fixedKeeperPlayerSeasonId': 'player-01', 'minimumStintMs': 180000, 'batchLimit': 3, 'scoreLeadThreshold': 2, 'returnToNormalEnabled': False}
assert set(canonical['components']['schemas']['PolicyPayload']['properties']) == set(payload)
assert valid('ProspectivePolicyPayload', payload)
command = {'id': 'event-1', 'type': 'policy.changed', 'sample': {'monotonicMs': 15500, 'sessionId': 'session-1', 'wallTimeMs': 1800000000000}, 'policySchemaVersion': 1, 'policyVersion': 2, 'previousPolicyVersion': 1, 'sourceRevision': 17, 'effective': {'half': 1, 'halfElapsedMs': 15000, 'matchElapsedMs': 15000}, 'reason': 'Reviewed future playing preferences.', 'payload': payload, 'applicability': {'minimumStint': 'soft_preference', 'batchLimit': 'soft_preference', 'q07': 'unapproved'}, 'softPreferences': {'halfBufferFraction': 0.1}}
assert valid('PolicyChangeCommand', command)
assert valid('PolicyChangeCommand', {**command, 'effective': {'half': 0, 'halfElapsedMs': 0, 'matchElapsedMs': 0}, 'resetPositionMode': True})
for patch in [{'reason': '    '}, {'reason': 'abcd '}, {'reason': ' a b '}, {'policyVersion': 0}, {'previousPolicyVersion': -1}, {'sourceRevision': -1}, {'policySchemaVersion': 2}, {'approvedQ07': True}]:
    assert not valid('PolicyChangeCommand', {**command, **patch}), patch
for field, values in [('minimumStintMs', [-1, 0.5]), ('batchLimit', [0, 12]), ('scoreLeadThreshold', [0])]:
    for value in values:
        assert not valid('PolicyChangeCommand', {**command, 'payload': {**payload, field: value}})
for patch in [{'batchLimit': 'hard_limit'}, {'minimumStint': 'hard_limit'}, {'q07': 'accepted'}]:
    assert not valid('PolicyChangeCommand', {**command, 'applicability': {**command['applicability'], **patch}})
for fraction in [-0.1, 0.5]:
    assert not valid('PolicyChangeCommand', {**command, 'softPreferences': {'halfBufferFraction': fraction}})
envelope = {'contractVersion': 'longball.events/1.1', 'schemaVersion': 1, 'engineVersion': 'synthetic-live-4', 'eventId': 'event-1', 'matchId': 'match-1', 'deviceId': 'device-1', 'controllerEpoch': 2, 'clientSequence': 6, 'previousEventId': 'prior-event', 'baseRevision': 17, 'effectiveHalf': 1, 'halfElapsedMs': 15000, 'matchElapsedMs': 15000, 'effectiveAt': None, 'recordedAt': '2026-10-21T12:00:00Z', 'timeQuality': 'reviewRequired', 'clockEvidence': {'monotonicMs': 15500, 'anchorId': 'anchor-1', 'continuityId': 'session-1'}, 'command': command}
assert valid('MatchCommandEnvelope', envelope)
for patch in [{'engineVersion': 'synthetic-live-3'}, {'controllerEpoch': 0}, {'clientSequence': 0}, {'baseRevision': -1}, {'effectiveHalf': 3}, {'schemaVersion': 2}]:
    assert not valid('MatchCommandEnvelope', {**envelope, **patch})
assert not valid('MatchCommandEnvelope', {**envelope, 'command': {**command, 'policyVersion': 0}})
params = {p['$ref'] for p in contract['paths']['/matches/{matchId}/events']['parameters']}
assert {'#/components/parameters/ControllerToken', '#/components/parameters/IdempotencyKey', '#/components/parameters/ContractVersion'} <= params
print('EV05 canonical payload parity, explicit soft applicability, unapproved Q07, source/version boundary and current engine envelope cases passed')
