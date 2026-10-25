import type { Membership, Principal } from "@longball/application/access";
import {
  buildCalendarExport,
  calendarEventsFromSchedule,
  type CalendarArtifact,
  type CalendarSchedule,
} from "@longball/application/calendar-export";
import type {
  WorkspaceBinding,
  WorkspaceSessionAccess,
} from "@longball/application/workspace-boundary";
import {
  sameWorkspaceBinding,
  workspaceBindingIsCurrent,
} from "@longball/application/workspace-boundary";
import { assertReportExportAccess } from "./report-export-access";

export class CalendarAccessDeniedError extends Error {}

/** Fresh, scoped data and authority are both required before exporting a copy. */
export async function exportScopedCalendar(input: {
  source: WorkspaceBinding;
  currentBinding: () => WorkspaceBinding | null;
  readIdentity: () => Promise<{
    principal: Principal;
    memberships: Membership[];
  }>;
  readSchedule: () => Promise<
    CalendarSchedule & {
      team: { id: string };
      activeSeasonId?: string;
      season?: { id: string };
    }
  >;
  session: {
    requiredSessionId: string;
    read: () => Promise<WorkspaceSessionAccess | null>;
  } | null;
  selectedKeys: string[];
  nowMs: () => number;
  deliver: (
    artifact: CalendarArtifact,
    assertAccess: () => Promise<void>,
  ) => Promise<string>;
}): Promise<string> {
  const { source } = input;
  if (!["manager", "player"].includes(source.role))
    throw new Error(
      "Calendar export requires a current manager or own-player schedule.",
    );
  const verify = async () => {
    const identity = await input.readIdentity();
    if (!sameWorkspaceBinding(source, input.currentBinding()))
      throw new Error("The export context changed. No file was opened.");
    if (
      !workspaceBindingIsCurrent(
        source,
        identity.principal,
        identity.memberships,
        input.nowMs(),
      )
    )
      throw new CalendarAccessDeniedError(
        "The export context changed because current schedule access was withdrawn. No file was opened.",
      );
    await assertReportExportAccess({
      source,
      currentBinding: input.currentBinding,
      principal: identity.principal,
      memberships: identity.memberships,
      nowMs: input.nowMs,
      session: input.session,
    });
  };
  await verify();
  const schedule = await input.readSchedule();
  await verify();
  if (
    schedule.team.id !== source.teamId ||
    (schedule.activeSeasonId ?? schedule.season?.id) !== source.seasonId
  )
    throw new Error(
      "The calendar schedule differs from the selected team or season. No file was opened.",
    );
  const nowMs = input.nowMs();
  const events = calendarEventsFromSchedule(schedule, source.seasonId, nowMs);
  const artifact = buildCalendarExport({
    teamId: source.teamId,
    seasonId: source.seasonId,
    events,
    selectedKeys: input.selectedKeys,
    nowMs,
  });
  return input.deliver(artifact, verify);
}
