import type { WorkspaceOutboxRequest, WorkspaceRequestOutcome } from '@longball/application/workspace-outbox';

/** A restored queued write may have committed before its failure was persisted. */
export function workspaceCommandPreviouslyUnconfirmed(input: {
  key: string;
  knownUnconfirmed: boolean;
  protectedPending: WorkspaceOutboxRequest | null | undefined;
  initialEnqueueReceipt: boolean;
}): boolean {
  return input.knownUnconfirmed || Boolean(input.protectedPending?.key === input.key && (
    input.protectedPending.lastFailure || !input.initialEnqueueReceipt
  ));
}

/** A later refusal cannot prove that an earlier unconfirmed write did not commit. */
export function workspaceCommandFailureOutcome(input: {
  httpStatus: number;
  code: string;
  serverRequestId?: string | null;
  previouslyUnconfirmed: boolean;
}): WorkspaceRequestOutcome {
  const { httpStatus, code } = input;
  const definitive = !input.previouslyUnconfirmed && (
    httpStatus >= 400 && httpStatus < 500 && ![401, 403, 404, 408, 425, 429].includes(httpStatus) ||
    httpStatus === 503 && ['POLICY_APPROVAL_REQUIRED', 'SEASON_ASSIGNMENT_REQUIRED'].includes(code)
  );
  return definitive
    ? { kind: 'refused', httpStatus, code, serverRequestId: input.serverRequestId ?? null }
    : { kind: 'unconfirmed', reason: httpStatus === 401 ? 'authentication' : [403, 404].includes(httpStatus) ? 'access' : 'retryable_service', httpStatus, code };
}
