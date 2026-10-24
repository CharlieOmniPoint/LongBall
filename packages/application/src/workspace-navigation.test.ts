import { describe, expect, it } from 'vitest';
import { mergeWorkspaceControllerStatus, workspaceNavigationDecision, type WorkspaceControllerState, type WorkspaceControllerStatus, type WorkspaceNavigationFlags } from './workspace-navigation';

const active = (changes: Partial<WorkspaceControllerState> = {}): WorkspaceControllerState => ({ scope: 'connected-rehearsal', matchId: 'match-a', deviceId: 'phone-a', epoch: 4, lifecycle: 'active', unsent: false, pendingNetwork: false, pendingCount: 0, hasControl: true, reconciliationRequired: false, ...changes });
const flags: WorkspaceNavigationFlags = { privateCapability: false, memoryPending: false, busy: false, savedPending: false, controllerPending: false, controllerUnsent: false };

describe('connected workspace navigation evidence', () => {
  it('copies an initial current controller update without changing its input', () => {
    const input = active({ unsent: true, pendingCount: 2 });
    const result = mergeWorkspaceControllerStatus('new', null, 'new', input);
    expect(result).toEqual({ source: 'new', state: input });
    expect(result?.state).not.toBe(input);
    expect(input.hasControl).toBe(true);
  });

  it('ignores a delayed old-source close without clearing the new context pending request', () => {
    const previous: WorkspaceControllerStatus = { source: 'new', state: active({ unsent: true, pendingNetwork: true, pendingCount: 3 }) };
    const delayed = active({ lifecycle: 'closed', hasControl: false, epoch: null });
    expect(mergeWorkspaceControllerStatus('new', previous, 'old', delayed)).toBe(previous);
    expect(previous.state.pendingNetwork).toBe(true);
    expect(previous.state.pendingCount).toBe(3);
  });

  it('cannot initialise a current context from an old callback', () => {
    expect(mergeWorkspaceControllerStatus('new', null, 'old', active())).toBeNull();
  });

  it('preserves same-source acknowledgement uncertainty and unsent evidence after unmount', () => {
    const previous: WorkspaceControllerStatus = { source: 'same', state: active({ unsent: true, pendingNetwork: true, pendingCount: 4 }) };
    const result = mergeWorkspaceControllerStatus('same', previous, 'same', active({ lifecycle: 'closed', hasControl: true, epoch: null }));
    expect(result?.state).toMatchObject({ lifecycle: 'closed', hasControl: false, unsent: true, pendingNetwork: true, pendingCount: 4 });
    expect(previous.state.lifecycle).toBe('active');
  });

  it('keeps any newer closed-state evidence and never carries old identity evidence into a new source', () => {
    const previous: WorkspaceControllerStatus = { source: 'same', state: active({ pendingCount: 1 }) };
    const result = mergeWorkspaceControllerStatus('same', previous, 'same', active({ lifecycle: 'closed', unsent: true, pendingNetwork: true, pendingCount: 5 }));
    expect(result?.state).toMatchObject({ hasControl: false, unsent: true, pendingNetwork: true, pendingCount: 5 });
    const switched = mergeWorkspaceControllerStatus('new', result, 'new', active({ lifecycle: 'closed' }));
    expect(switched?.state).toMatchObject({ unsent: false, pendingNetwork: false, pendingCount: 0, hasControl: false });
  });

  it('accepts a current active epoch-null refusal clearing an earlier acquire request', () => {
    const previous: WorkspaceControllerStatus = { source: 'same', state: active({ epoch: null, hasControl: false, pendingNetwork: true }) };
    const result = mergeWorkspaceControllerStatus('same', previous, 'same', active({ epoch: null, hasControl: false }));
    expect(result?.state).toMatchObject({ lifecycle: 'active', epoch: null, hasControl: false, pendingNetwork: false, pendingCount: 0, unsent: false });
  });

  it('accepts a current acknowledged active update clearing saved unsent evidence', () => {
    const previous: WorkspaceControllerStatus = { source: 'same', state: active({ lifecycle: 'closed', unsent: true, pendingCount: 3, pendingNetwork: true }) };
    expect(mergeWorkspaceControllerStatus('same', previous, 'same', active())?.state).toEqual(active());
  });

  it('blocks private capabilities, uncertain in-memory requests or active work before any durable warning', () => {
    for (const key of ['privateCapability', 'memoryPending', 'busy'] as const) {
      expect(workspaceNavigationDecision({ ...flags, [key]: true, savedPending: true, controllerUnsent: true })).toBe('blocked');
    }
  });

  it('requires an explicit saved-work warning for each durable or controller uncertainty', () => {
    for (const key of ['savedPending', 'controllerPending', 'controllerUnsent'] as const) expect(workspaceNavigationDecision({ ...flags, [key]: true })).toBe('review_saved');
  });

  it('allows navigation only when there is no retained or active-work evidence', () => {
    expect(workspaceNavigationDecision(flags)).toBe('leave');
    expect(flags).toEqual({ privateCapability: false, memoryPending: false, busy: false, savedPending: false, controllerPending: false, controllerUnsent: false });
  });
});
