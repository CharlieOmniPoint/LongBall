/** View-only controller evidence. This never creates a controller capability. */
export interface WorkspaceControllerState {
  scope: 'connected-rehearsal';
  matchId: string;
  deviceId: string;
  epoch: number | null;
  lifecycle: 'active' | 'closed';
  unsent: boolean;
  pendingNetwork: boolean;
  pendingCount: number;
  hasControl: boolean;
  reconciliationRequired: boolean;
}
export interface WorkspaceControllerStatus { source: string; state: WorkspaceControllerState }

/** Late/unmount callbacks cannot discard another context's pending evidence. */
export function mergeWorkspaceControllerStatus(
  currentSource: string,
  previous: WorkspaceControllerStatus | null,
  incomingSource: string,
  state: WorkspaceControllerState,
): WorkspaceControllerStatus | null {
  if (incomingSource !== currentSource) return previous;
  const prior = previous?.source === currentSource ? previous.state : null;
  return {
    source: incomingSource,
    state: state.lifecycle === 'closed'
      ? {
          ...state,
          hasControl: false,
          unsent: Boolean(prior?.unsent || state.unsent),
          pendingNetwork: Boolean(prior?.pendingNetwork || state.pendingNetwork),
          pendingCount: Math.max(prior?.pendingCount ?? 0, state.pendingCount),
        }
      : { ...state },
  };
}

export interface WorkspaceNavigationFlags {
  privateCapability: boolean;
  memoryPending: boolean;
  busy: boolean;
  savedPending: boolean;
  controllerPending: boolean;
  controllerUnsent: boolean;
}
/** Memory-held requests block exit; durable unresolved work requires an explicit warning. */
export function workspaceNavigationDecision(flags: WorkspaceNavigationFlags): 'blocked' | 'review_saved' | 'leave' {
  if (flags.privateCapability || flags.memoryPending || flags.busy) return 'blocked';
  if (flags.savedPending || flags.controllerPending || flags.controllerUnsent) return 'review_saved';
  return 'leave';
}
