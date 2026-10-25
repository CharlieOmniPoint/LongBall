import type { Membership, Principal } from "@longball/application/access";
import {
  sameWorkspaceBinding,
  workspaceBindingIsCurrent,
  workspaceSessionAllows,
  type WorkspaceBinding,
  type WorkspaceSessionAccess,
} from "@longball/application/workspace-boundary";

/** Read the mutable scope again after native credential I/O, immediately before export. */
export async function assertReportExportAccess({
  source,
  currentBinding,
  principal,
  memberships,
  nowMs,
  session,
}: {
  source: WorkspaceBinding;
  currentBinding: () => WorkspaceBinding | null;
  principal: Principal | null;
  memberships: Membership[];
  nowMs: () => number;
  session: {
    requiredSessionId: string;
    read: () => Promise<WorkspaceSessionAccess | null>;
  } | null;
}): Promise<void> {
  const assertCurrentScope = () => {
    if (
      !sameWorkspaceBinding(source, currentBinding()) ||
      !workspaceBindingIsCurrent(source, principal, memberships, nowMs())
    )
      throw new Error("The export context changed. No file was opened.");
  };
  assertCurrentScope();
  if (!session) return;
  const current = await session.read();
  // Scope buttons remain available during export; a pending vault read must not
  // allow a report from the previous team, season, audience or generation out.
  assertCurrentScope();
  if (
    !current ||
    !session.requiredSessionId ||
    !workspaceSessionAllows(current, source.apiBaseUrl, nowMs()) ||
    current.sessionId !== session.requiredSessionId ||
    current.accountId !== source.accountId ||
    current.issuer !== source.issuer ||
    current.subject !== source.subject
  )
    throw new Error("The export session closed. No file was opened.");
}
