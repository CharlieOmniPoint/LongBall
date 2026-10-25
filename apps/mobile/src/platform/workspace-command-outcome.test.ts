import { describe, expect, it } from 'vitest';
import { createWorkspaceOutbox, enqueueWorkspaceRequest, recordWorkspaceOutcome, validateWorkspaceOutbox, type WorkspaceOutboxState } from '@longball/application/workspace-outbox';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';
import { workspaceCommandFailureOutcome, workspaceCommandPreviouslyUnconfirmed } from './workspace-command-outcome';

const now = 1_800_000_000_000;
const binding: WorkspaceBinding = { generation: 1, apiBaseUrl: 'https://api.example', accountId: 'player-account', issuer: 'https://issuer.example', subject: 'player-subject', teamId: 'roma-u10', seasonId: '2026-27', role: 'player', playerId: 'player-01' };
const request = { path: '/v1/teams/roma-u10/community?seasonId=2026-27', key: 'same-command-0001', label: 'Community change', body: { command: { id: 'same-command-0001', expectedRevision: 7, type: 'ballot.cast', matchId: 'match-01', candidatePlayerId: 'player-02' } } };
const queued = () => enqueueWorkspaceRequest(createWorkspaceOutbox(binding), binding, request, now);
const reopen = (state: WorkspaceOutboxState): WorkspaceOutboxState => JSON.parse(JSON.stringify(state)) as WorkspaceOutboxState;

describe('workspace command refusal after an unconfirmed write', () => {
  it('keeps the exact protected command through later definitive refusals until a validated receipt', () => {
    for (const [httpStatus, code] of [[400, 'INVALID_COMMAND'], [409, 'REVISION_CONFLICT'], [422, 'VALIDATION_FAILED'], [503, 'POLICY_APPROVAL_REQUIRED']] as const) {
      let state = reopen(recordWorkspaceOutcome(queued(), request.key, { kind: 'unconfirmed', reason: 'network' }, now + 1));
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = workspaceCommandFailureOutcome({ httpStatus, code, previouslyUnconfirmed: Boolean(state.pending?.lastFailure) });
        expect(outcome.kind).toBe('unconfirmed');
        state = reopen(recordWorkspaceOutcome(state, request.key, outcome, now + 2 + attempt));
        validateWorkspaceOutbox(state);
        expect(state.pending?.key).toBe(request.key);
        expect(state.pending?.bodyJson).toBe(JSON.stringify(request.body));
        expect(state.lastSettled).toBeNull();
      }
      state = recordWorkspaceOutcome(state, request.key, { kind: 'accepted', httpStatus: 200, serverRevision: 8 }, now + 5);
      expect(state.pending).toBeNull();
      expect(state.lastSettled?.request.key).toBe(request.key);
      expect(state.lastSettled?.request.bodyJson).toBe(JSON.stringify(request.body));
    }
  });

  it('preserves correction after a first immediate definitive refusal', () => {
    for (const httpStatus of [400, 409, 422]) {
      const previouslyUnconfirmed = workspaceCommandPreviouslyUnconfirmed({ key: request.key, knownUnconfirmed: false, protectedPending: queued().pending, initialEnqueueReceipt: true });
      expect(previouslyUnconfirmed).toBe(false);
      const outcome = workspaceCommandFailureOutcome({ httpStatus, code: 'INVALID_COMMAND', previouslyUnconfirmed });
      expect(outcome.kind).toBe('refused');
      const state = recordWorkspaceOutcome(queued(), request.key, outcome, now + 1);
      expect(state.pending).toBeNull();
      expect(state.lastSettled?.outcome.kind).toBe('refused');
    }
  });

  it('treats a restored awaiting-receipt write as uncertain even if a crash prevented failure persistence', () => {
    const restored = reopen(queued());
    expect(restored.pending?.status).toBe('awaiting_receipt');
    expect(restored.pending?.lastFailure).toBeNull();
    const previouslyUnconfirmed = workspaceCommandPreviouslyUnconfirmed({ key: request.key, knownUnconfirmed: false, protectedPending: restored.pending, initialEnqueueReceipt: false });
    expect(previouslyUnconfirmed).toBe(true);
    for (const httpStatus of [400, 409, 422]) {
      const outcome = workspaceCommandFailureOutcome({ httpStatus, code: 'REVISION_CONFLICT', previouslyUnconfirmed });
      const next = recordWorkspaceOutcome(restored, request.key, outcome, now + 1);
      expect(next.pending?.key).toBe(request.key);
      expect(next.pending?.bodyJson).toBe(JSON.stringify(request.body));
      expect(next.lastSettled).toBeNull();
    }
    expect(workspaceCommandPreviouslyUnconfirmed({ key: request.key, knownUnconfirmed: false, protectedPending: null, initialEnqueueReceipt: false })).toBe(false);
    expect(workspaceCommandPreviouslyUnconfirmed({ key: 'different-key', knownUnconfirmed: false, protectedPending: restored.pending, initialEnqueueReceipt: false })).toBe(false);
  });

  it('keeps authentication, access and retryable refusals unconfirmed even on the first attempt', () => {
    for (const httpStatus of [401, 403, 404, 408, 425, 429, 500, 503]) {
      expect(workspaceCommandFailureOutcome({ httpStatus, code: 'TEMPORARY', previouslyUnconfirmed: false }).kind).toBe('unconfirmed');
    }
  });
});
