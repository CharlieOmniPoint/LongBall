import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Membership } from '../../../packages/application/src/access';
import type { CommunityState } from '../../../packages/application/src/community';
import type { PreparationState } from '../../../packages/application/src/preparation';
import type { NamedWorkspaceMembership } from '../../../packages/application/src/workspace-context';
import { createApi } from './server';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';
import { namedWorkspaceMembership } from './workspace-memberships';

const now = Date.UTC(2026, 9, 21, 12);
const running: ReturnType<typeof createApi>[] = [], directories: string[] = [];
async function start() {
  const directory = mkdtempSync(join(tmpdir(), 'longball-own-workspaces-'));
  directories.push(directory);
  const api = createApi({ databasePath: join(directory, 'service.sqlite'), syntheticAuth: true, now: () => now });
  running.push(api);
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call = async (route = '/v1/me', token = 'synthetic-manager-1', command?: unknown, role?: string) => {
    const response = await fetch(base + route, { method: command ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${token}`,
      ...(role ? { 'X-Longball-Role': role } : {}),
      ...(command ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION } : {}),
    }, body: command ? JSON.stringify({ command }) : undefined });
    return { status: response.status, body: await response.json() as { memberships: NamedWorkspaceMembership[] } };
  };
  return { api, call };
}
afterEach(async () => {
  for (const api of running.splice(0)) { api.server.closeAllConnections(); await api.close(); }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('own workspace names are display metadata rather than authority', () => {
  it('validates optional names while preserving every original authority field', () => {
    const membership: Membership = { accountId: 'child', teamId: 'team', seasonId: 'season', role: 'player', playerId: 'linked-player', expiresAt: null, revokedAt: null };
    expect(namedWorkspaceMembership(membership, { team_name: ' Roma ', age_group: 'U10', club_name: ' Richmond Rovers ', season_label: '26/27' })).toEqual({ ...membership, teamName: 'Roma U10', clubName: 'Richmond Rovers', seasonLabel: '26/27' });
    expect(namedWorkspaceMembership(membership, { team_name: 'Roma U10', age_group: 'U10' })).toEqual({ ...membership, teamName: 'Roma U10' });
    expect(namedWorkspaceMembership(membership, { team_name: 'x'.repeat(121), club_name: 'private\nvalue', season_label: '   ', age_group: {} })).toEqual(membership);
  });

  it('serves only current own named memberships without private preparation or peer accounts', async () => {
    const { api, call } = await start();
    const manager = await call();
    expect(manager.status).toBe(200);
    expect(manager.body.memberships).toHaveLength(2);
    expect(manager.body.memberships.every(member => member.accountId === 'synthetic-account-manager')).toBe(true);
    expect(manager.body.memberships.map(member => member.role).sort()).toEqual(['administrator', 'manager']);
    expect(manager.body.memberships.every(member => member.teamName === 'Roma U10' && member.clubName === 'Richmond Rovers' && member.seasonLabel === '2026/27')).toBe(true);
    const identity = { issuer: 'urn:longball:synthetic', subject: 'synthetic-account-manager', strongAuth: true, authenticatedAt: now };
    const plain = api.store.myMemberships(api.store.principal(identity));
    expect(manager.body.memberships.map(({ teamName: _team, clubName: _club, seasonLabel: _season, ...member }) => member)).toEqual(JSON.parse(JSON.stringify(plain)));
    expect(plain.every(member => !('teamName' in member))).toBe(true);
    const child = await call('/v1/me', 'synthetic-account-player-01');
    expect(child.body.memberships).toEqual([expect.objectContaining({ role: 'player', playerId: 'synthetic-player-01', teamName: 'Roma U10' })]);
    expect(JSON.stringify(child.body)).not.toContain('synthetic-player-02');
    expect(JSON.stringify(child.body)).not.toContain('Ralph Barrett');
    expect(JSON.stringify(manager.body)).not.toContain('synthetic-account-manager-2');
    expect(JSON.stringify(manager.body)).not.toContain('profiles');
  });

  it('reflects actual configuration renames immediately in a fresh child identity read', async () => {
    const { api, call } = await start();
    const route = `/v1/teams/${SYNTHETIC_IDS.teamId}/configuration?seasonId=${SYNTHETIC_IDS.seasonId}`;
    const preparation = api.store.document<PreparationState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation');
    const team = await call(route, 'synthetic-manager-1', { id: randomUUID(), expectedRevision: preparation.revision, type: 'team.updated', name: 'Roma Lions', ageGroup: 'U11', defaultPitchPlaces: preparation.team.defaultPitchPlaces, defaultHalfDurationMs: preparation.team.defaultHalfDurationMs, logo: null }, 'manager');
    expect(team.status).toBe(200);
    const club = await call(route, 'synthetic-admin', { id: randomUUID(), expectedRevision: preparation.revision + 1, type: 'club.updated', name: 'Richmond Rovers Juniors', logo: null }, 'administrator');
    expect(club.status).toBe(200);
    const child = await call('/v1/me', 'synthetic-account-player-01');
    expect(child.status).toBe(200);
    expect(child.body.memberships[0]).toMatchObject({ teamId: SYNTHETIC_IDS.teamId, seasonId: SYNTHETIC_IDS.seasonId, role: 'player', playerId: 'synthetic-player-01', teamName: 'Roma Lions U11', clubName: 'Richmond Rovers Juniors', seasonLabel: '2026/27' });
    // Display freshness never grants the child the administrator's source document.
    expect((await call(route, 'synthetic-account-player-01')).status).toBe(404);
  });

  it('does not borrow another season or foreign team metadata and leaves unknown labels absent', async () => {
    const { api, call } = await start();
    const store = api.store;
    store.database.prepare("INSERT INTO teams(id,name) VALUES('sample-unknown-team','Unconfigured U12'),('sample-private-team','Hidden peer team')").run();
    store.database.prepare("INSERT INTO memberships(account_id,team_id,season_id,role) VALUES('synthetic-account-manager','sample-unknown-team','unknown-season','manager'),('synthetic-account-manager',?,'unknown-season','manager')").run(SYNTHETIC_IDS.teamId);
    const preparation = store.document<PreparationState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'preparation');
    store.saveDocument(SYNTHETIC_IDS.teamId, 'unknown-season', 'preparation', preparation);
    const result = await call();
    const unknown = result.body.memberships.find(member => member.teamId === 'sample-unknown-team')!;
    expect(unknown).toMatchObject({ teamName: 'Unconfigured U12' });
    expect(unknown).not.toHaveProperty('clubName');
    expect(unknown).not.toHaveProperty('seasonLabel');
    const unmatched = result.body.memberships.find(member => member.teamId === SYNTHETIC_IDS.teamId && member.seasonId === 'unknown-season')!;
    expect(unmatched).not.toHaveProperty('clubName');
    expect(unmatched).not.toHaveProperty('seasonLabel');
    expect(JSON.stringify(result.body)).not.toContain('Hidden peer team');
  });

  it('rechecks revoked memberships, spectator grants and expiry before returning any names', async () => {
    const { api, call } = await start();
    expect((await call('/v1/me', 'synthetic-spectator')).body.memberships).toHaveLength(1);
    const community = api.store.document<CommunityState>(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community');
    const revoked: CommunityState = { ...community, grants: community.grants.map(grant => ({ ...grant, revokedAtMs: now })) };
    api.store.saveDocument(SYNTHETIC_IDS.teamId, SYNTHETIC_IDS.seasonId, 'community', revoked);
    expect((await call('/v1/me', 'synthetic-spectator')).body.memberships).toEqual([]);
    api.store.database.prepare("UPDATE memberships SET revoked_at=? WHERE account_id='synthetic-account-manager-2'").run(now);
    expect((await call('/v1/me', 'synthetic-manager-2')).body.memberships).toEqual([]);
    api.store.database.prepare("UPDATE memberships SET expires_at=? WHERE account_id='synthetic-account-player-01'").run(now);
    expect((await call('/v1/me', 'synthetic-account-player-01')).body.memberships).toEqual([]);
  });
});
