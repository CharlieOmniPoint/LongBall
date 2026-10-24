import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { InvitationMemoryClient } from "@longball/application/invitation-client";
import type { HttpFetch } from "@longball/application/sync";
import { ConnectedInvitationsPanel } from "./ConnectedInvitationsPanel";
import { Notice } from "../ui";

export interface ScopedWorkspaceInvitationsProps {
  baseUrl: string;
  authenticatedFetch: HttpFetch;
  scopeKey: string;
  active: boolean;
  assertCurrent: () => void;
  disabled: boolean;
  teamId: string | null;
  seasonId: string | null;
  canIssue: boolean;
  contributionsAllowed?: boolean;
  invitationDestination?: { teamId: string; seasonId: string; code: string };
  onChanged: (acceptedScope?: {
    teamId: string;
    seasonId: string;
  }) => void | Promise<void>;
  onRetainedChange: (retained: boolean, scopeKey: string) => void;
}
/** Scope changes dispose this memory-only client instead of migrating its credentials or pending request. */
export function ScopedWorkspaceInvitations(
  props: ScopedWorkspaceInvitationsProps,
) {
  return <ScopedInvitationsContent key={props.scopeKey} {...props} />;
}
function ScopedInvitationsContent(props: ScopedWorkspaceInvitationsProps) {
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  });
  const [client, setClient] = useState<InvitationMemoryClient | null>(null);
  const baseUrl = props.baseUrl;
  useEffect(() => {
    let alive = true;
    const instance = new InvitationMemoryClient({
      baseUrl,
      authenticatedFetch: (url, options) =>
        live.current.authenticatedFetch(url, options),
      assertCurrent: () => {
        if (!live.current.active)
          throw new Error(
            "The invitation workspace is closed. Reopen the current verified identity.",
          );
        live.current.assertCurrent();
      },
    });
    void Promise.resolve().then(() => {
      if (alive) setClient(instance);
    });
    return () => {
      alive = false;
      instance.close();
    };
  }, [baseUrl]);
  if (!client)
    return <Notice>Opening the private invitation workspace…</Notice>;
  return (
    <ConnectedInvitationsPanel
      client={client}
      scopeKey={props.scopeKey}
      active={props.active}
      assertCurrent={props.assertCurrent}
      disabled={props.disabled}
      teamId={props.teamId}
      seasonId={props.seasonId}
      canIssue={props.canIssue}
      contributionsAllowed={props.contributionsAllowed}
      invitationDestination={props.invitationDestination}
      onChanged={props.onChanged}
      onRetainedChange={props.onRetainedChange}
    />
  );
}
