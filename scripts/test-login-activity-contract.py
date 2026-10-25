"""Validate Super Admin activity report shape and privacy boundaries.

These are wire/schema checks. Actual identity/RLS, collection, distinct-account
aggregation, cursor timestamp semantics and lifecycle tests run separately.
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
    valid = not list(jsonschema.Draft202012Validator(schema).iter_errors(value))
    assert valid == expected, (name, 'valid expected' if expected else 'invalid expected')
    checks += 1


def denied(name, value):
    accepted(name, value, False)


now = 1792936800000
cursor = f"2.{now}.100.{now - 1000}.event-one.{'a' * 16}"
scope = {'clubId': 'club-one', 'clubName': 'Northfield Juniors', 'teamId': 'team-one',
         'teamName': 'Roma', 'seasonId': 'season-26-27', 'role': 'super_admin'}
event = {'id': 'login-event-one', 'at': now - 1000, 'type': 'login_success', 'provider': 'demo',
         'accountId': 'account-one', 'actorLabel': 'Sam Taylor', 'role': 'super_admin',
         'scopes': [scope], 'reason': None, 'count': 1}
failure = {'id': 'login-event-two', 'at': now - 500, 'type': 'login_failure', 'provider': 'spectator_pin',
           'accountId': None, 'actorLabel': None, 'role': None, 'scopes': [],
           'reason': 'invalid_credentials', 'count': 3}
dto = {
    'kind': 'login-analytics', 'observedAt': now, 'eventAsOf': now, 'from': now - 7 * 86400000,
    'filters': {'range': '7d'},
    'summary': {'signIns': 1, 'failedAttempts': 3, 'uniqueAccounts': 1, 'activeAccounts': 1,
                'activeSessions': 1, 'enabledAccounts': 12, 'lastSignInAt': now - 1000},
    'directory': {'clubs': [{'id': 'club-one', 'name': 'Northfield Juniors'}],
                  'teams': [{'id': 'team-one', 'clubId': 'club-one', 'name': 'Roma', 'ageGroup': 'U10'}]},
    'trend': [{'from': now - 86400000, 'to': now, 'signIns': 1, 'failedAttempts': 3, 'uniqueAccounts': 1}],
    'roles': [{'role': 'super_admin', 'label': 'Super Admin', 'signIns': 1, 'uniqueAccounts': 1, 'activeAccounts': 1}],
    'clubs': [{'clubId': 'club-one', 'clubName': 'Northfield Juniors', 'teamCount': 1,
               'signIns': 1, 'uniqueAccounts': 1, 'activeAccounts': 1, 'lastSeenAt': now - 100}],
    'teams': [{'teamId': 'team-one', 'teamName': 'Roma', 'clubId': 'club-one',
               'clubName': 'Northfield Juniors', 'ageGroup': 'U10', 'signIns': 1,
               'uniqueAccounts': 1, 'activeAccounts': 1, 'lastSeenAt': now - 100}],
    'activeUsers': [{'accountId': 'account-one', 'label': 'Sam Taylor', 'role': 'super_admin',
                     'lastSeenAt': now - 100, 'sessionCount': 1, 'scopes': [scope]}],
    'events': [event, failure], 'page': {'nextCursor': None, 'limit': 50},
    'coverage': {'startedAt': now - 10000, 'eventRowsTruncated': False, 'activityRowsTruncated': False, 'scopeRowsTruncated': False,
                  'eventLimit': 20000, 'activityWindowMinutes': 15, 'pollingIncluded': True,
                  'upstreamProviderFailuresIncluded': False, 'collectionHealthy': True},
    'definitions': ['Activity means authenticated API use, including polling, in the last 15 minutes.'],
}
accepted('LoginAnalyticsDto', dto)
accepted('LoginAnalyticsEvent', failure)
empty = deepcopy(dto)
empty.update({name: [] for name in ['trend', 'roles', 'clubs', 'teams', 'activeUsers', 'events']})
empty['directory'] = {'clubs': [], 'teams': []}
empty['summary'] = dict.fromkeys(['signIns', 'failedAttempts', 'uniqueAccounts', 'activeAccounts',
                                'activeSessions', 'enabledAccounts'], 0)
empty['summary']['lastSignInAt'] = None
empty['coverage']['startedAt'] = None
accepted('LoginAnalyticsDto', empty)

for field in dto:
    denied('LoginAnalyticsDto', {key: value for key, value in dto.items() if key != field})
for name, value in [('LoginAnalyticsEvent', event), ('LoginAnalyticsScope', scope),
                    ('LoginAnalyticsSummary', dto['summary']), ('LoginAnalyticsPage', dto['page']),
                    ('LoginAnalyticsCoverage', dto['coverage']), ('LoginAnalyticsActiveUser', dto['activeUsers'][0])]:
    for field in value:
        denied(name, {key: item for key, item in value.items() if key != field})

# Every object layer refuses credential, contact, fingerprint or authority extras.
private_fields = ['password', 'passcode', 'accessToken', 'refreshToken', 'tokenHash', 'verifier',
                  'salt', 'username', 'ipAddress', 'userAgent', 'sessionId', 'rawHeaders',
                  'ordinal', 'highWater', 'runtimeId', 'sessionObservationId']
layers = [(), ('filters',), ('summary',), ('directory',), ('directory', 'clubs', 0),
          ('directory', 'teams', 0), ('trend', 0), ('roles', 0), ('clubs', 0), ('teams', 0),
          ('activeUsers', 0), ('activeUsers', 0, 'scopes', 0), ('events', 0),
          ('events', 0, 'scopes', 0), ('page',), ('coverage',)]
for layer in layers:
    for field in private_fields:
        value = deepcopy(dto)
        node = value
        for key in layer:
            node = node[key]
        node[field] = 'not-allowed'
        denied('LoginAnalyticsDto', value)

for value in [0, 1, 9007199254740991]:
    accepted('LoginAnalyticsCount', value)
    accepted('LoginAnalyticsTimestamp', value)
for value in [-1, 0.5, True, False, None, '0', 9007199254740992]:
    denied('LoginAnalyticsCount', value)
    denied('LoginAnalyticsTimestamp', value)
for role in ['super_admin', 'club_admin', 'manager', 'player', 'spectator']:
    accepted('LoginAnalyticsRole', role)
for role in ['administrator', 'super', 'owner', 'SUPER_ADMIN', None]:
    denied('LoginAnalyticsRole', role)
for kind in ['login_success', 'login_failure', 'logout']:
    accepted('LoginAnalyticsEventType', kind)
for kind in ['api.read', 'provider_failure', 'password_verified', 'logout\n', None]:
    denied('LoginAnalyticsEventType', kind)
for provider in ['demo', 'spectator_pin', 'oidc']:
    accepted('LoginAnalyticsProvider', provider)
for provider in ['unknown', 'password', 'biometric', None]:
    denied('LoginAnalyticsProvider', provider)

for filters in [{'range': '24h'}, {'range': '7d', 'clubId': 'club-one'},
                {'range': '30d', 'clubId': 'club-one', 'teamId': 'team-one',
                 'role': 'player', 'event': 'login_success', 'cursor': cursor}]:
    accepted('LoginAnalyticsFilters', filters)
for patch in [{'range': '365d'}, {'range': None}, {'clubId': ''}, {'teamId': '../other'},
              {'clubId': 'club-one\n'}, {'role': 'administrator'}, {'event': 'login'},
              {'cursor': ''}, {'cursor': 'token'}, {'cursor': cursor + '\n'},
              {'cursor': '1.5:event'}, {'cursor': '-1:event'}, {'accountId': 'another'},
              {'principal': {'administration': {'level': 'super'}}}, {'includeSecrets': True}]:
    denied('LoginAnalyticsFilters', {**dto['filters'], **patch})
denied('LoginAnalyticsFilters', {})

for sessions in [None, 0, 12]:
    accepted('LoginAnalyticsSummary', {**dto['summary'], 'activeSessions': sessions})
    accepted('LoginAnalyticsActiveUser', {**dto['activeUsers'][0], 'sessionCount': sessions})
for patch in [{'activeSessions': -1}, {'enabledAccounts': True}, {'lastSignInAt': -1}]:
    denied('LoginAnalyticsSummary', {**dto['summary'], **patch})
for size in [0, 1, 50]:
    accepted('LoginAnalyticsDto', {**dto, 'events': [event] * size})
denied('LoginAnalyticsDto', {**dto, 'events': [event] * 51})
accepted('LoginAnalyticsEvent', {**event, 'scopes': [scope] * 500})
denied('LoginAnalyticsEvent', {**event, 'scopes': [scope] * 501})
accepted('LoginAnalyticsDto', {**dto, 'activeUsers': [dto['activeUsers'][0]] * 100})
denied('LoginAnalyticsDto', {**dto, 'activeUsers': [dto['activeUsers'][0]] * 101})
denied('LoginAnalyticsDto', {**dto, 'trend': [dto['trend'][0]] * 31})
for wrong_cursor in [f'{now}:event-one', cursor + '\n', cursor.replace('2.', '1.', 1),
                     cursor[:-1], cursor + 'a', cursor.replace('event-one', '../event'),
                     cursor.replace('.' + 'a' * 16, '.' + 'A' * 16)]:
    denied('LoginAnalyticsCursor', wrong_cursor)
for patch in [{'limit': 49}, {'limit': 51}, {'limit': True}, {'nextCursor': 'private-token'},
              {'nextCursor': cursor, 'sessionToken': 'not-allowed'}]:
    denied('LoginAnalyticsPage', {**dto['page'], **patch})
accepted('LoginAnalyticsPage', {'nextCursor': cursor, 'limit': 50})
for patch in [{'eventLimit': 19999}, {'activityWindowMinutes': 30}, {'pollingIncluded': False},
              {'upstreamProviderFailuresIncluded': True}, {'collectionHealthy': 'yes'},
              {'startedAt': -1}, {'eventRowsTruncated': 1}, {'scopeRowsTruncated': 'yes'}]:
    denied('LoginAnalyticsCoverage', {**dto['coverage'], **patch})
accepted('LoginAnalyticsCoverage', {**dto['coverage'], 'eventRowsTruncated': True,
                                     'activityRowsTruncated': True, 'scopeRowsTruncated': True, 'collectionHealthy': False})
# Reporting also preserves existing administrator-edited age labels; this is not
# the separate U5-U21 team-creation command validator.
for age in ['U5', 'U10', 'U21', 'U10 Blue', 'Mini Soccer']:
    accepted('LoginAnalyticsTeamRow', {**dto['teams'][0], 'ageGroup': age})
for age in ['', ' ', 'U10\n', 'x' * 13]:
    denied('LoginAnalyticsTeamRow', {**dto['teams'][0], 'ageGroup': age})

operation = contract['paths']['/administration/login-analytics']
assert set(operation) == {'get'}
read = operation['get']
assert read.get('security', contract['security']) == [{'bearerAuth': []}]
assert 'Super Admin' in read['summary']
assert 'current stronger authentication' in read['description']
assert 'five-minute authentication-age requirement' in read['description']
assert 'no-store' in read['responses']['200']['description']
assert 'requestBody' not in read
assert read['responses']['200']['content']['application/json']['schema']['$ref'] == '#/components/schemas/LoginAnalyticsDto'
assert {'400', '401', '403', '404', '429', '503'} <= set(read['responses'])
assert {p['name'] for p in read['parameters']} == {'range', 'clubId', 'teamId', 'role', 'event', 'cursor'}
assert all(p['in'] == 'query' and p['required'] is False for p in read['parameters'])
assert all(p.get('name') not in private_fields for p in read['parameters'])
checks += 10
print(f'Login activity contract: {checks} strict schema, pagination, metadata privacy and Super Admin boundary cases passed; collection, authority and device proofs remain separate.')
