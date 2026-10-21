import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { REVIEW_IDENTITIES } from '../../../packages/application/src/review-entry';
import { createApi } from './server';
import { EVENT_CONTRACT_VERSION, SYNTHETIC_IDS } from './store';

describe('distinct fictional entry identity HTTP authority', () => {
  it('keeps administrator configuration separate from private match control and manager staff powers', async () => {
    const api = createApi({ databasePath: ':memory:', syntheticAuth: true });
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    try {
      const admin = REVIEW_IDENTITIES.administrator, manager = REVIEW_IDENTITIES.manager;
      const matchPath = `/v1/matches/${SYNTHETIC_IDS.matchId}`;
      const teamPath = `/v1/teams/${SYNTHETIC_IDS.teamId}`;
      const call = async (path: string, token: string, role: string, body?: unknown) => {
        const response = await fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Longball-Role': role, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Api-Contract-Version': EVENT_CONTRACT_VERSION }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const me = await call('/v1/me', admin.token, admin.role);
      expect(me.body.principal).toMatchObject({ accountId: admin.accountId, adultVerified: true, strongAuth: true });
      expect((me.body.memberships as { role: string }[]).map(member => member.role)).toEqual(['administrator']);
      const configuration = await call(`${teamPath}/configuration?seasonId=${SYNTHETIC_IDS.seasonId}`, admin.token, admin.role);
      expect(configuration.status).toBe(200);
      expect(configuration.body).not.toHaveProperty('profiles');
      for (const role of ['administrator', 'manager']) {
        const download = await call(`${matchPath}/download?deviceId=review-admin-device`, admin.token, role);
        expect(download.status).toBe(404); expect(download.body).not.toHaveProperty('state');
        const controller = await call(`${matchPath}/controller`, admin.token, role, { deviceId: 'review-admin-device' });
        expect(controller.status).toBe(404); expect(controller.body).not.toHaveProperty('controllerToken');
      }
      const managerIdentity = await call('/v1/me', manager.token, manager.role);
      expect((managerIdentity.body.memberships as { role: string }[]).map(member => member.role)).toEqual(['manager']);
      expect((await call(`${teamPath}/managers?seasonId=${SYNTHETIC_IDS.seasonId}`, manager.token, 'administrator')).status).toBe(404);
      expect((await call(`${teamPath}/managers`, manager.token, 'administrator', { accountId: 'synthetic-account-manager-5' })).status).toBe(404);
      expect(api.store.database.prepare('SELECT COUNT(*) AS n FROM controller_grants').get()).toEqual({ n: 0 });
      expect(api.store.match(SYNTHETIC_IDS.matchId).state_json).toContain('"revision":0');
    } finally { api.server.closeAllConnections(); await api.close(); }
  });
});
