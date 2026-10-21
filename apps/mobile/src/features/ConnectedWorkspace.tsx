import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Image,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  currentMemberships,
  type Membership,
  type Principal,
} from "@longball/application/access";
import type {
  CommunityActor,
  CommunityCommand,
  getCommunityView,
} from "@longball/application/community";
import {
  positionCodes,
  type AvailabilityResponse,
  type PlayerProfile,
  type PreparationCommand,
  type PreparationSeason,
  type PreparationState,
} from "@longball/application/preparation";
import type {
  HistoricalResultInput,
  RecordsCommand,
  selectMatchReport,
  selectParticipationReport,
  selectSeasonResults,
} from "@longball/application/records";
import {
  LongBallServiceClient,
  ServiceError,
} from "@longball/application/sync";
import type { MatchState } from "@longball/domain";
import {
  connectedFetch,
  getConnectedSessionSummary,
  subscribeConnectedSessionChanges,
  type ConnectedSessionSummary,
} from "../platform/auth/client";
import {
  attachWorkspaceValue,
  readWorkspaceValue,
  sameWorkspaceBinding,
  workspaceBindingIsCurrent,
  workspaceSessionAllows,
  type BoundWorkspaceValue,
  type WorkspaceBinding,
} from "@longball/application/workspace-boundary";
import { base64Url } from "@longball/application/security";
import { MediaUploadClient } from "../platform/media-client";
import { randomUUID } from "../platform/id";
import type { Journal, JournalDiagnostics } from "../platform/types";
import {
  authorizeWorkspaceReplay,
  workspaceOutboxDocumentId,
  workspaceOutboxStorageAllowed,
  type WorkspaceOutboxState,
  type WorkspaceRequestOutcome,
} from "@longball/application/workspace-outbox";
import { Button, Card, Notice, Pill } from "../ui";
import { colors, typography } from "../ui/tokens";
import { PreparationScreens } from "./PreparationScreens";
import { ServicePanel, type ServicePanelProps } from "./ServicePanel";
import { MediaUpload } from "./MediaUpload";
import {
  WorkspaceOutboxBridge,
  type WorkspaceOutboxPort,
  type WorkspaceOutboxStatus,
} from "./WorkspaceOutboxBridge";

export interface ConnectedWorkspaceProps {
  allowSynthetic?: boolean;
  journal?: Journal | null;
  deviceId?: string | null;
  match?: MatchState | null;
  teamId?: string;
  seasonId?: string;
  onControllerState?: ServicePanelProps["onControllerState"];
}
type Connection = {
  baseUrl: string;
  mode: "oidc" | "synthetic";
  account: string;
};
type Identity = {
  principal: Principal;
  memberships: Membership[];
  serverTime: string;
};
type CommunityDto = ReturnType<typeof getCommunityView> & { revision: number };
type RecordsDto = {
  revision: number;
  results: ReturnType<typeof selectSeasonResults>;
  participation: ReturnType<typeof selectParticipationReport>;
  matches: ReturnType<typeof selectMatchReport>[];
};
interface OwnPreparationDto {
  kind: "player-preparation";
  revision: number;
  team: { id: string; name: string; ageGroup: string };
  season: PreparationSeason;
  profile: PlayerProfile;
  fixtures: {
    id: string;
    opponent: string;
    playedDate: string;
    kickoff: string | null;
    venue: string;
    homeAway: string;
    status: string;
    response: AvailabilityResponse;
    selected: boolean;
    attendance: string;
  }[];
  training: {
    id: string;
    date: string;
    time: string | null;
    venue: string;
    status: string;
    expected: boolean;
    response: AvailabilityResponse;
    attendance: string;
  }[];
}
type OwnCommand = { id: string; expectedRevision: number } & (
  | { type: "own.preferences_saved"; preferences: PlayerProfile["preferences"] }
  | {
      type: "own.fixture_response_recorded";
      fixtureId: string;
      response: AvailabilityResponse;
    }
  | {
      type: "own.training_response_recorded";
      trainingId: string;
      response: AvailabilityResponse;
    }
);
type OwnPayload = OwnCommand extends infer C
  ? C extends OwnCommand
    ? Omit<C, "id" | "expectedRevision">
    : never
  : never;
type CommunityPayload = CommunityCommand extends infer C
  ? C extends CommunityCommand
    ? Omit<C, "id" | "expectedRevision">
    : never
  : never;
type Tab =
  | "schedule"
  | "team"
  | "settings"
  | "reports"
  | "community"
  | "controller";
interface PendingRequest {
  path: string;
  key: string;
  body: unknown;
  label: string;
  bodyJson?: string;
  protected?: boolean;
}
const defaultTeam = "synthetic-roma-u10",
  defaultSeason = "synthetic-season-2026-27";
const responseLabels: Record<AvailabilityResponse, string> = {
  available: "Available",
  unavailable: "Unavailable",
  unsure: "Unsure",
  no_reply: "No reply",
};
const failureText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The service request could not complete.";
const duration = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
const dateTime = (ms: number | null) =>
  ms === null ? "Not established" : new Date(ms).toLocaleString("en-GB");

/** Reads and commands go to the service; this screen does not grant roles or seed its own remote records. */
export function ConnectedWorkspace(props: ConnectedWorkspaceProps) {
  const allowSynthetic =
    props.allowSynthetic ??
    process.env.EXPO_PUBLIC_ENVIRONMENT !== "production";
  const [baseUrl, setBaseUrl] = useState(
    process.env.EXPO_PUBLIC_API_BASE_URL ||
      (Platform.OS === "web" ? "/" : "http://127.0.0.1:4310"),
  );
  const [mode, setMode] = useState<Connection["mode"]>("oidc");
  const [account, setAccount] = useState("synthetic-manager-1");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={s.stack} testID="connected-workspace">
      <Card>
        <Text style={typography.section}>Service workspace</Text>
        <Text style={typography.body}>
          Open the team held by the service. Saved changes can be read on
          another connected device.
        </Text>
        <Text style={typography.label}>API URL</Text>
        <TextInput
          accessibilityLabel="Workspace API URL"
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          style={s.input}
        />
        <View style={s.row}>
          <Button
            label="Connected sign-in"
            variant={mode === "oidc" ? "primary" : "secondary"}
            onPress={() => setMode("oidc")}
          />
          {allowSynthetic && (
            <Button
              label="Fictional API review"
              variant={mode === "synthetic" ? "primary" : "secondary"}
              onPress={() => setMode("synthetic")}
            />
          )}
        </View>
        {mode === "oidc" ? (
          <Notice>
            Sign in under Account security first. Its unlocked credential is
            sent only to its configured API. Roles and adult authority come from
            that service.
          </Notice>
        ) : allowSynthetic ? (
          <>
            <Pill tone="warning">PUBLIC FICTIONAL IDENTITIES</Pill>
            <Text style={typography.muted}>
              These selectors work only on an API explicitly running synthetic
              authentication. They do not authenticate a person or provide
              real-account security.
            </Text>
            <View style={s.row}>
              {[
                ["synthetic-manager-1", "Fictional manager"],
                ["synthetic-account-player-01", "Fictional Player 01"],
                ["synthetic-spectator", "Fictional spectator"],
                ["synthetic-account-invitee", "Fictional invite recipient"],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  label={label}
                  variant={account === value ? "primary" : "secondary"}
                  onPress={() => setAccount(value)}
                />
              ))}
            </View>
          </>
        ) : (
          <Notice tone="error">
            Fictional API identities are disabled in this build.
          </Notice>
        )}
        <Text style={typography.muted}>
          Browser review: use / with the combined app/API server. The standalone
          API uses port 4310. A physical phone needs the development host
          address or a USB port mapping.
        </Text>
        {error && <Notice tone="error">{error}</Notice>}
        <Button
          label="Open service workspace"
          testID="workspace-connect"
          onPress={() => {
            try {
              if (mode === "synthetic" && !allowSynthetic)
                throw new Error(
                  "Fictional API identities are disabled in this build.",
                );
              const validated = new LongBallServiceClient(baseUrl, async () => {
                throw new Error("Not connected.");
              });
              setConnection({ baseUrl: validated.baseUrl, mode, account });
              setError(null);
            } catch (cause) {
              setError(failureText(cause));
            }
          }}
        />
      </Card>
      {connection && (connection.mode !== "synthetic" || allowSynthetic) && (
        <WorkspaceEntry
          key={`${connection.baseUrl}|${connection.mode}|${connection.account}|${props.teamId}|${props.seasonId}`}
          connection={connection}
          {...props}
          allowSynthetic={allowSynthetic}
        />
      )}
    </View>
  );
}

function WorkspaceEntry(
  props: ConnectedWorkspaceProps & { connection: Connection },
) {
  return props.connection.mode === "oidc" ? (
    <OidcWorkspace {...props} />
  ) : (
    <WorkspaceSession {...props} />
  );
}
function OidcWorkspace(
  props: ConnectedWorkspaceProps & { connection: Connection },
) {
  const [session, setSession] = useState<ConnectedSessionSummary | null>(null);
  const [now, setNow] = useState(Date.now);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const absoluteApi =
    Platform.OS === "web"
      ? new URL(
          props.connection.baseUrl || "/",
          globalThis.location.origin,
        ).toString()
      : props.connection.baseUrl;
  useEffect(() => {
    let alive = true,
      active = true,
      sequence = 0;
    const check = async (hide = false) => {
      const request = ++sequence;
      if (hide) setSession(null);
      try {
        const next = await getConnectedSessionSummary();
        if (!alive || !active || request !== sequence) return;
        setNow(Date.now());
        setSession(next);
        setError(null);
      } catch (cause) {
        if (alive && request === sequence) {
          setSession(null);
          setError(failureText(cause));
        }
      }
    };
    const onChange = () => {
      if (alive) {
        setSession(null);
        void check();
      }
    };
    const unsubscribe = subscribeConnectedSessionChanges(onChange);
    void check();
    const timer = setInterval(() => {
      if (active) void check();
    }, 1_000);
    const foreground = (visible: boolean) => {
      active = visible;
      ++sequence;
      setSession(null);
      if (active) void check();
    };
    const listener = AppState.addEventListener("change", (state) =>
      foreground(state === "active"),
    );
    const visibility = () =>
      foreground(globalThis.document.visibilityState === "visible");
    if (Platform.OS === "web")
      globalThis.document.addEventListener("visibilitychange", visibility);
    return () => {
      alive = false;
      ++sequence;
      clearInterval(timer);
      unsubscribe();
      listener.remove();
      if (Platform.OS === "web")
        globalThis.document.removeEventListener("visibilitychange", visibility);
    };
  }, [retry]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        setSession(null);
        setNow(Date.now());
      },
      Math.min(2_147_000_000, Math.max(0, session.expiresAtMs - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [session]);
  if (!workspaceSessionAllows(session, absoluteApi, now))
    return (
      <Card>
        <Text style={typography.section}>Connected workspace locked</Text>
        <Notice>
          {error ??
            "An active, unlocked sign-in for this API is required. Private workspace views are closed when the session locks, expires or changes."}
        </Notice>
        <Button
          label="Recheck connected identity"
          variant="secondary"
          onPress={() => setRetry((value) => value + 1)}
        />
      </Card>
    );
  return (
    <WorkspaceSession
      key={`${session!.sessionId}|${session!.accountId}|${session!.issuer}|${session!.subject}|${session!.config.apiBaseUrl}|${session!.expiresAtMs}|${JSON.stringify(session!.memberships)}`}
      {...props}
      oidcSession={session!}
    />
  );
}

function WorkspaceSession({
  connection,
  teamId: requestedTeamId,
  seasonId: requestedSeasonId,
  oidcSession,
  ...props
}: ConnectedWorkspaceProps & {
  connection: Connection;
  oidcSession?: ConnectedSessionSummary;
}) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [membershipTime, setMembershipTime] = useState(Date.now);
  const [scopeChoice, setScopeChoice] = useState<{
    teamId: string;
    seasonId: string;
  } | null>(null);
  const [preparationCache, setPreparation] =
    useState<BoundWorkspaceValue<PreparationState> | null>(null);
  const [ownCache, setOwn] =
    useState<BoundWorkspaceValue<OwnPreparationDto> | null>(null);
  const [recordsCache, setRecords] =
    useState<BoundWorkspaceValue<RecordsDto> | null>(null);
  const [communityCache, setCommunity] =
    useState<BoundWorkspaceValue<CommunityDto> | null>(null);
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);
  const generation = useRef(0);
  const liveBinding = useRef<WorkspaceBinding | null>(null);
  const invalidateRequests = useCallback(() => {
    ++generation.current;
    liveBinding.current = null;
  }, []);
  const [tab, setTab] = useState<Tab>("schedule");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [memoryPending, setPending] = useState<PendingRequest | null>(null);
  const [outboxStatus, setOutboxStatus] =
    useState<WorkspaceOutboxStatus | null>(null);
  const outboxPort = useRef<WorkspaceOutboxPort | null>(null);
  const [storage, setStorage] = useState<{
    journal: Journal;
    diagnostics: JournalDiagnostics;
  } | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteTeamId, setInviteTeamId] = useState("");
  const [inviteSeasonId, setInviteSeasonId] = useState("");
  const [serviceMatchId, setServiceMatchId] = useState(
    props.match?.config.matchId ?? "",
  );
  const lock = useRef(false);
  const oidcSessionId = oidcSession?.sessionId;
  const oidcAccountId = oidcSession?.accountId;
  const oidcIssuer = oidcSession?.issuer;
  const oidcSubject = oidcSession?.subject;
  const verifiedMemberships = identity
    ? currentMemberships(
        identity.principal,
        identity.memberships,
        membershipTime,
      )
    : [];
  const initialMembership =
    verifiedMemberships.find((item) => item.role === "manager") ??
    verifiedMemberships.find((item) => item.role === "player") ??
    verifiedMemberships.find((item) => item.role === "spectator");
  const teamId =
    scopeChoice?.teamId ??
    requestedTeamId ??
    (connection.mode === "synthetic" ? defaultTeam : initialMembership?.teamId);
  const seasonId =
    scopeChoice?.seasonId ??
    requestedSeasonId ??
    (connection.mode === "synthetic"
      ? defaultSeason
      : initialMembership?.seasonId);
  const path = (section: string) => {
    if (!teamId || !seasonId)
      throw new Error("The service has not granted a team and season scope.");
    return `/v1/teams/${encodeURIComponent(teamId)}/${section}?seasonId=${encodeURIComponent(seasonId)}`;
  };
  const authenticatedFetch = useMemo<
    (url: string, options: RequestInit) => Promise<Response>
  >(
    () => async (url, options) => {
      if (connection.mode === "oidc") {
        const absolute =
          url.startsWith("/") && Platform.OS === "web"
            ? new URL(url, globalThis.location.origin).toString()
            : url;
        return connectedFetch(absolute, options);
      }
      return fetch(url, {
        ...options,
        redirect: "error",
        headers: {
          ...Object.fromEntries(new Headers(options.headers).entries()),
          Authorization: `Bearer ${connection.account}`,
        },
      });
    },
    [connection],
  );
  const client = useMemo(
    () => new LongBallServiceClient(connection.baseUrl, authenticatedFetch),
    [connection.baseUrl, authenticatedFetch],
  );
  const absoluteApi =
    Platform.OS === "web"
      ? new URL(client.baseUrl || "/", globalThis.location.origin)
          .toString()
          .replace(/\/$/, "")
      : client.baseUrl.replace(/\/$/, "");
  const storageChecked = !props.journal || storage?.journal === props.journal;
  const protectedOutbox = Boolean(
    props.journal &&
      props.deviceId &&
      storage?.journal === props.journal &&
      workspaceOutboxStorageAllowed({
        platform: Platform.OS === "web" ? "web" : "native",
        synthetic: connection.mode === "synthetic",
        diagnostics: storage.diagnostics,
      }),
  );
  const currentOutboxId =
    protectedOutbox && binding ? workspaceOutboxDocumentId(binding) : null;
  const currentOutbox =
    outboxStatus?.state &&
    currentOutboxId === workspaceOutboxDocumentId(outboxStatus.state.scope)
      ? outboxStatus
      : null;
  const restored = protectedOutbox ? currentOutbox?.state?.pending : null;
  const pending: PendingRequest | null =
    memoryPending ??
    (restored
      ? {
          path: restored.path,
          key: restored.key,
          body: JSON.parse(restored.bodyJson) as unknown,
          bodyJson: restored.bodyJson,
          label: restored.label,
          protected: true,
        }
      : null);
  useEffect(() => {
    const journal = props.journal;
    if (!journal) return;
    let alive = true;
    void (async () => {
      try {
        let diagnostics = await journal.getDiagnostics();
        if (
          diagnostics.mode === "encrypted-native" &&
          diagnostics.wrongKeyProbe === "not-run"
        ) {
          await journal.runCipherProbe();
          diagnostics = await journal.getDiagnostics();
        }
        if (alive) setStorage({ journal, diagnostics });
      } catch (cause) {
        if (alive)
          setErrors([
            `Protected request storage could not be verified: ${failureText(cause)}`,
          ]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.journal]);
  const actor = identity
    ? currentMemberships(
        identity.principal,
        identity.memberships,
        membershipTime,
      ).filter((item) => item.teamId === teamId && item.seasonId === seasonId)
    : [];
  const membership =
    actor.find((item) => item.role === "manager") ??
    actor.find((item) => item.role === "player") ??
    actor.find((item) => item.role === "spectator");
  const manager =
    membership?.role === "manager" &&
    binding?.teamId === teamId &&
    binding?.seasonId === seasonId &&
    workspaceBindingIsCurrent(
      binding,
      identity?.principal ?? null,
      identity?.memberships ?? [],
      membershipTime,
    );
  const expectedBinding =
    binding?.teamId === teamId && binding?.seasonId === seasonId
      ? binding
      : null;
  const preparation = readWorkspaceValue(
    preparationCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const own =
    membership?.role === "player"
      ? readWorkspaceValue(
          ownCache,
          expectedBinding,
          identity?.principal ?? null,
          identity?.memberships ?? [],
          membershipTime,
        )
      : null;
  const records = readWorkspaceValue(
    recordsCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const community = readWorkspaceValue(
    communityCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const communityActor: CommunityActor | null =
    identity && membership && teamId && seasonId
      ? {
          accountId: identity.principal.accountId,
          teamId,
          seasonId,
          role: membership.role as CommunityActor["role"],
          playerId: membership.playerId,
        }
      : null;

  useEffect(() => {
    const timer = setInterval(() => setMembershipTime(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const now = Date.now();
    const expiresAt = Math.min(
      ...(identity?.memberships ?? []).flatMap((item) =>
        item.expiresAt != null && item.expiresAt > now ? [item.expiresAt] : [],
      ),
    );
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(
      () => setMembershipTime(Date.now()),
      Math.min(2_147_000_000, Math.max(0, expiresAt - now)),
    );
    return () => clearTimeout(timer);
  }, [identity, membershipTime]);

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    liveBinding.current = null;
    setBinding(null);
    setIdentity(null);
    setPreparation(null);
    setOwn(null);
    setRecords(null);
    setCommunity(null);
    const nextIdentity = await client.me<Identity>();
    if (generation.current !== requestGeneration) return;
    if (
      oidcSessionId &&
      (nextIdentity.principal.accountId !== oidcAccountId ||
        nextIdentity.principal.issuer !== oidcIssuer ||
        nextIdentity.principal.subject !== oidcSubject)
    )
      throw new Error(
        "The service identity differs from the current sign-in. Reconnect before opening private workspace data.",
      );
    setIdentity(nextIdentity);
    const current = currentMemberships(
      nextIdentity.principal,
      nextIdentity.memberships,
      Date.now(),
    );
    const initial =
      current.find((item) => item.role === "manager") ??
      current.find((item) => item.role === "player") ??
      current.find((item) => item.role === "spectator");
    const resolvedTeamId =
      scopeChoice?.teamId ??
      requestedTeamId ??
      (connection.mode === "synthetic" ? defaultTeam : initial?.teamId);
    const resolvedSeasonId =
      scopeChoice?.seasonId ??
      requestedSeasonId ??
      (connection.mode === "synthetic" ? defaultSeason : initial?.seasonId);
    if (!resolvedTeamId || !resolvedSeasonId) {
      setPreparation(null);
      setOwn(null);
      setRecords(null);
      setCommunity(null);
      setErrors([
        "The verified service account has no current team and season membership. Activation or assignment must be completed through the configured service.",
      ]);
      return;
    }
    const scopedPath = (section: string) =>
      `/v1/teams/${encodeURIComponent(resolvedTeamId)}/${section}?seasonId=${encodeURIComponent(resolvedSeasonId)}`;
    const memberships = current.filter(
      (item) =>
        item.teamId === resolvedTeamId && item.seasonId === resolvedSeasonId,
    );
    const isManager = memberships.some((item) => item.role === "manager"),
      isPlayer = memberships.some((item) => item.role === "player");
    const chosen =
      memberships.find((item) => item.role === "manager") ??
      memberships.find((item) => item.role === "player") ??
      memberships.find((item) => item.role === "spectator");
    const ticket: WorkspaceBinding = {
      generation: requestGeneration,
      apiBaseUrl: absoluteApi,
      accountId: nextIdentity.principal.accountId,
      issuer: nextIdentity.principal.issuer,
      subject: nextIdentity.principal.subject,
      teamId: resolvedTeamId,
      seasonId: resolvedSeasonId,
      role: (chosen?.role as WorkspaceBinding["role"]) ?? "spectator",
      playerId: chosen?.playerId ?? null,
    };
    liveBinding.current = ticket;
    setBinding(ticket);
    const stillCurrent = async () => {
      if (
        generation.current !== requestGeneration ||
        !sameWorkspaceBinding(ticket, liveBinding.current)
      )
        return false;
      if (oidcSessionId) {
        const latest = await getConnectedSessionSummary();
        const api =
          Platform.OS === "web"
            ? new URL(
                client.baseUrl || "/",
                globalThis.location.origin,
              ).toString()
            : client.baseUrl;
        if (
          !workspaceSessionAllows(latest, api, Date.now()) ||
          latest?.sessionId !== oidcSessionId ||
          latest.accountId !== ticket.accountId ||
          latest.issuer !== ticket.issuer ||
          latest.subject !== ticket.subject
        )
          return false;
      }
      return (
        generation.current === requestGeneration &&
        sameWorkspaceBinding(ticket, liveBinding.current)
      );
    };
    const attach = async <T,>(value: T) =>
      (await stillCurrent())
        ? attachWorkspaceValue(
            ticket,
            liveBinding.current,
            nextIdentity.principal,
            nextIdentity.memberships,
            Date.now(),
            value,
          )
        : null;
    const faults: string[] = [];
    const tasks: Promise<void>[] = [
      client
        .request<CommunityDto>(scopedPath("community"))
        .then(async (value) => {
          const attached = await attach(value);
          if (attached) setCommunity(attached);
        })
        .catch((cause) => {
          if (generation.current === requestGeneration)
            faults.push(`Community: ${failureText(cause)}`);
        }),
      client
        .request<RecordsDto>(scopedPath("records"))
        .then(async (reply) => {
          const attached = await attach({
            revision: reply.revision,
            results: reply.results,
            participation: reply.participation,
            matches: reply.matches,
          });
          if (attached) setRecords(attached);
        })
        .catch((cause) => {
          if (generation.current === requestGeneration)
            faults.push(`Reports: ${failureText(cause)}`);
        }),
    ];
    if (isManager)
      tasks.push(
        client
          .request<PreparationState>(scopedPath("preparation"))
          .then(async (value) => {
            const attached = await attach(value);
            if (attached) setPreparation(attached);
          })
          .catch((cause) => {
            if (generation.current === requestGeneration)
              faults.push(`Preparation: ${failureText(cause)}`);
          }),
      );
    if (!isManager && isPlayer)
      tasks.push(
        client
          .request<OwnPreparationDto>(scopedPath("preparation/own"))
          .then(async (value) => {
            if (value.profile.playerId !== ticket.playerId)
              throw new Error(
                "The returned profile is outside this account's own-player scope.",
              );
            const attached = await attach(value);
            if (attached) setOwn(attached);
          })
          .catch((cause) => {
            if (generation.current === requestGeneration)
              faults.push(`Own preparation: ${failureText(cause)}`);
          }),
      );
    await Promise.all(tasks);
    if (await stillCurrent()) setErrors(faults);
  }, [
    client,
    scopeChoice,
    requestedTeamId,
    requestedSeasonId,
    connection.mode,
    absoluteApi,
    oidcSessionId,
    oidcAccountId,
    oidcIssuer,
    oidcSubject,
  ]);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(async () => {
      if (!live) return;
      setBusy(true);
      try {
        await load();
      } catch (cause) {
        if (live) setErrors([failureText(cause)]);
      } finally {
        if (live) setBusy(false);
      }
    });
    return () => {
      live = false;
      invalidateRequests();
    };
  }, [load, invalidateRequests]);

  const execute = async (
    request: PendingRequest,
    retained?: WorkspaceOutboxState,
  ): Promise<boolean> => {
    let outcomeAttempted = false;
    const durable = request.protected === true;
    const settle = async (outcome: WorkspaceRequestOutcome) => {
      outcomeAttempted = true;
      if (durable && !(await outboxPort.current?.settle(request.key, outcome)))
        throw new Error(
          "The service outcome has not been saved in protected storage. Retry the protected request save before another network attempt.",
        );
    };
    try {
      const invitation =
        (request.body as { command?: { type?: string } }).command?.type ===
        "invite.accepted";
      const fresh = await client.me<Identity>();
      const verifiedAtMs = Date.now();
      if (
        !identity ||
        fresh.principal.accountId !== identity.principal.accountId ||
        fresh.principal.issuer !== identity.principal.issuer ||
        fresh.principal.subject !== identity.principal.subject
      )
        throw new ServiceError(
          "IDENTITY_CHANGED",
          403,
          "The current service account changed. This request is retained; reopen its original account before retrying.",
          false,
        );
      const session =
        connection.mode === "oidc" ? await getConnectedSessionSummary() : null;
      if (
        connection.mode === "oidc" &&
        (!session ||
          !workspaceSessionAllows(session, absoluteApi, Date.now()) ||
          session?.sessionId !== oidcSessionId ||
          session.accountId !== fresh.principal.accountId ||
          session.issuer !== fresh.principal.issuer ||
          session.subject !== fresh.principal.subject)
      )
        throw new ServiceError(
          "INVALID_SESSION",
          401,
          "An active unlocked sign-in for the original request account is required.",
          false,
        );
      let bodyJson = request.bodyJson ?? JSON.stringify(request.body);
      if (!invitation) {
        const live = liveBinding.current;
        if (
          !binding ||
          !sameWorkspaceBinding(binding, live) ||
          !workspaceBindingIsCurrent(
            binding,
            fresh.principal,
            fresh.memberships,
            Date.now(),
          )
        )
          throw new ServiceError(
            "ACCESS_CHANGED",
            403,
            "Current access does not allow this request. Its original content is retained.",
            false,
          );
        if (durable) {
          if (!protectedOutbox)
            throw new Error(
              "Protected request storage is not currently verified. The service request has not been sent.",
            );
          const state = retained ?? outboxPort.current?.snapshot();
          if (!state || state.pending?.key !== request.key)
            throw new Error(
              "Save the exact protected request before sending it to the service.",
            );
          bodyJson = authorizeWorkspaceReplay(state, {
            binding: live!,
            principal: fresh.principal,
            memberships: fresh.memberships,
            verifiedAtMs,
            nowMs: Date.now(),
            synthetic: connection.mode === "synthetic",
            session,
          }).bodyJson;
        }
      }
      const response = await authenticatedFetch(
        `${client.baseUrl}${request.path}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": request.key,
            "X-Api-Contract-Version": "longball.events/1.1",
          },
          body: bodyJson,
        },
      );
      let body: {
        code?: string;
        message?: string;
        revision?: number;
        requestId?: string;
      };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        await settle({
          kind: "unconfirmed",
          reason: "unreadable",
          httpStatus: response.status,
        });
        throw new Error(
          "The service response was unreadable. The exact original request remains available for retry.",
        );
      }
      if (!response.ok) {
        const code = body.code ?? "HTTP_FAILURE";
        const definitive =
          (response.status >= 400 &&
            response.status < 500 &&
            ![401, 403, 404, 408, 425, 429].includes(response.status)) ||
          (response.status === 503 &&
            ["POLICY_APPROVAL_REQUIRED", "SEASON_ASSIGNMENT_REQUIRED"].includes(
              code,
            ));
        await settle(
          definitive
            ? {
                kind: "refused",
                httpStatus: response.status,
                code,
                serverRequestId: body.requestId ?? null,
              }
            : {
                kind: "unconfirmed",
                reason:
                  response.status === 401
                    ? "authentication"
                    : [403, 404].includes(response.status)
                      ? "access"
                      : "retryable_service",
                httpStatus: response.status,
                code,
              },
        );
        if (definitive) setPending(null);
        throw new ServiceError(
          code,
          response.status,
          body.message ?? "The service refused this change.",
          response.status >= 500 || response.status === 429,
        );
      }
      if (!Number.isSafeInteger(body.revision) || body.revision! < 0) {
        await settle({
          kind: "unconfirmed",
          reason: "unreadable",
          httpStatus: response.status,
        });
        throw new Error(
          "The service did not return a valid revision receipt. The exact request is retained.",
        );
      }
      await settle({
        kind: "accepted",
        httpStatus: response.status,
        serverRevision: body.revision,
        serverRequestId: response.headers.get("x-request-id"),
      });
      setPending(null);
      setNotice(
        `${request.label} saved by the service${durable ? " and its receipt retained on this device" : ""}.`,
      );
      try {
        await load();
      } catch (cause) {
        setErrors([
          `The command was accepted; the refreshed view is unavailable: ${failureText(cause)}`,
        ]);
      }
      return true;
    } catch (cause) {
      if (durable && !outcomeAttempted) {
        try {
          await settle({
            kind: "unconfirmed",
            reason:
              cause instanceof ServiceError && cause.status === 401
                ? "authentication"
                : cause instanceof ServiceError &&
                    [403, 404].includes(cause.status)
                  ? "access"
                  : "network",
            ...(cause instanceof ServiceError
              ? { httpStatus: cause.status, code: cause.code }
              : {}),
          });
        } catch {
          /* The exact pending request stays in the journal; its local save may need retry. */
        }
      }
      throw cause;
    }
  };
  const mutate = async (
    section: string,
    command:
      | PreparationCommand
      | OwnCommand
      | CommunityCommand
      | RecordsCommand,
    label: string,
    destination?: { teamId: string; seasonId: string },
  ): Promise<boolean> => {
    if (lock.current || pending) return false;
    lock.current = true;
    setBusy(true);
    setErrors([]);
    setNotice(null);
    try {
      if (
        !identity ||
        (oidcSessionId &&
          (identity.principal.accountId !== oidcAccountId ||
            identity.principal.issuer !== oidcIssuer ||
            identity.principal.subject !== oidcSubject))
      )
        throw new Error(
          "Verify the current service identity before sending this change.",
        );
      if (
        command.type !== "invite.accepted" &&
        (!sameWorkspaceBinding(binding, liveBinding.current) ||
          !workspaceBindingIsCurrent(
            binding,
            identity?.principal ?? null,
            identity?.memberships ?? [],
            Date.now(),
          ))
      )
        throw new Error(
          "This workspace scope is no longer current. Refresh or sign in again before changing it.",
        );
      if (
        destination &&
        (!/^[A-Za-z0-9_-]{1,150}$/.test(destination.teamId) ||
          !/^[A-Za-z0-9_-]{1,150}$/.test(destination.seasonId))
      )
        throw new Error(
          "Use the exact team and season identifiers from the invitation.",
        );
      const key = "id" in command ? command.id : command.commandId;
      const request = {
        path: destination
          ? `/v1/teams/${encodeURIComponent(destination.teamId)}/${section}?seasonId=${encodeURIComponent(destination.seasonId)}`
          : path(section),
        key,
        body: { command },
        label,
        protected: protectedOutbox && command.type !== "invite.accepted",
      };
      setPending(request);
      let retained: WorkspaceOutboxState | undefined;
      if (request.protected) {
        if (
          !binding ||
          !currentOutbox?.state ||
          currentOutbox.retryPending ||
          currentOutbox.conflict
        )
          throw new Error(
            "Wait for protected request storage or retry its outstanding save before sending.",
          );
        const saved = await outboxPort.current?.enqueue(binding, request);
        if (!saved)
          throw new Error(
            "The service request has not been sent because its exact command could not be saved. Retry protected storage first.",
          );
        retained = saved;
      }
      return await execute(request, retained);
    } catch (cause) {
      setErrors([failureText(cause)]);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const changeCommunity = (payload: CommunityPayload) =>
    mutate(
      "community",
      { ...payload, id: randomUUID(), expectedRevision: community?.revision },
      "Community change",
    );
  const reload = async () => {
    if (lock.current || pending) return;
    lock.current = true;
    setBusy(true);
    try {
      await load();
      setNotice("Read the latest service views.");
    } catch (cause) {
      setErrors([failureText(cause)]);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const disabled =
    busy ||
    Boolean(pending) ||
    !storageChecked ||
    (protectedOutbox &&
      (!currentOutbox?.state ||
        currentOutbox.busy ||
        currentOutbox.retryPending ||
        currentOutbox.conflict));
  return (
    <View style={s.stack} testID="workspace-session">
      <Card>
        <Pill tone={connection.mode === "synthetic" ? "warning" : "info"}>
          {connection.mode === "synthetic"
            ? "FICTIONAL API REVIEW"
            : "CONNECTED SERVICE"}
        </Pill>
        <Text style={typography.section}>
          {identity
            ? identity.principal.accountId
            : "Checking service identity…"}
        </Text>
        <Text style={typography.muted}>
          {membership
            ? `${membership.role} · ${teamId} · ${seasonId}`
            : "No current team membership returned."}
        </Text>
        {identity && (
          <Text style={typography.muted}>
            {identity.principal.identityClassification.replaceAll("_", " ")} ·{" "}
            {identity.principal.strongAuth
              ? "strong authentication verified by service"
              : "strong authentication not verified"}
          </Text>
        )}
        {verifiedMemberships.length > 1 && (
          <View style={s.row}>
            {Array.from(
              new Map(
                verifiedMemberships
                  .filter((item) =>
                    ["manager", "player", "spectator"].includes(item.role),
                  )
                  .map((item) => [`${item.teamId}:${item.seasonId}`, item]),
              ).values(),
            ).map((item) => (
              <Button
                key={`${item.teamId}:${item.seasonId}`}
                label={`${item.teamId} · ${item.seasonId}`}
                variant={
                  item.teamId === teamId && item.seasonId === seasonId
                    ? "primary"
                    : "secondary"
                }
                disabled={disabled}
                onPress={() => {
                  ++generation.current;
                  liveBinding.current = null;
                  setBinding(null);
                  setPreparation(null);
                  setOwn(null);
                  setRecords(null);
                  setCommunity(null);
                  setServiceMatchId("");
                  setScopeChoice({
                    teamId: item.teamId,
                    seasonId: item.seasonId,
                  });
                }}
              />
            ))}
          </View>
        )}
        {errors.map((error, index) => (
          <Notice key={`${index}:${error}`} tone="error">
            {error}
          </Notice>
        ))}
        {notice && <Notice>{notice}</Notice>}
        {protectedOutbox &&
        binding &&
        currentOutboxId &&
        props.journal &&
        props.deviceId ? (
          <WorkspaceOutboxBridge
            ref={outboxPort}
            key={currentOutboxId}
            binding={binding}
            journal={props.journal}
            deviceId={props.deviceId}
            onStatus={setOutboxStatus}
          />
        ) : (
          <Text style={typography.muted}>
            {storageChecked
              ? "Service changes use memory-only retry on this connection. Closing this workspace clears unsent or unresolved requests; real browser command bodies are not written to browser persistence."
              : "Checking protected request storage before enabling changes…"}
          </Text>
        )}
        {pending && (
          <>
            <Notice tone="warning">
              {pending.protected
                ? "A request is unresolved. Its exact command and key are retained in this protected workspace. Retry after the service verifies current access; a queued vote is never counted until the service accepts it before the cutoff."
                : "A request is unresolved. Its exact command and key remain on this open screen. This connection uses memory-only retry; closing this workspace clears the request."}
            </Notice>
            <Button
              label="Retry exact service request"
              testID="workspace-retry"
              disabled={
                busy ||
                (pending.protected === true &&
                  (!currentOutbox?.state ||
                    currentOutbox.busy ||
                    currentOutbox.retryPending ||
                    currentOutbox.conflict))
              }
              onPress={() => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                void execute(pending)
                  .catch((cause) => setErrors([failureText(cause)]))
                  .finally(() => {
                    lock.current = false;
                    setBusy(false);
                  });
              }}
            />
          </>
        )}
        <Button
          label={busy ? "Contacting service…" : "Refresh service views"}
          variant="secondary"
          disabled={disabled}
          onPress={() => {
            void reload();
          }}
        />
        <View style={s.row} accessibilityRole="tablist">
          {(
            [
              ["schedule", manager ? "Schedule" : "My schedule"],
              ...(manager
                ? [
                    ["team", "Squad"],
                    ["settings", "Team settings"],
                  ]
                : []),
              ["reports", "Reports"],
              ["community", "Community"],
              ...(manager && props.journal && props.deviceId
                ? [["controller", "Controller"]]
                : []),
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <Button
              key={value}
              label={label}
              testID={`workspace-tab-${value}`}
              variant={tab === value ? "primary" : "secondary"}
              onPress={() => setTab(value)}
            />
          ))}
        </View>
      </Card>
      {(tab === "schedule" || tab === "team" || tab === "settings") &&
        (manager && preparation ? (
          <PreparationScreens
            storage="service"
            state={preparation}
            view={tab}
            onChange={(command) =>
              mutate("preparation", command, "Preparation change")
            }
            busy={disabled}
            onOpenMatch={
              props.journal && props.deviceId
                ? (fixtureId) => {
                    setServiceMatchId(fixtureId);
                    setTab("controller");
                  }
                : undefined
            }
          />
        ) : own ? (
          <OwnPreparation
            key={`${own.profile.id}:${own.revision}`}
            value={own}
            disabled={disabled}
            onChange={(command) =>
              mutate("preparation/own", command, "Own preparation change")
            }
          />
        ) : (
          <Notice>
            {membership?.role === "spectator"
              ? "Spectator access does not include private squad preparation or attendance."
              : "Preparation is unavailable for this account. Check the service message above."}
          </Notice>
        ))}
      {tab === "reports" &&
        (membership && records ? (
          <ConnectedReports
            value={records}
            manager={manager}
            disabled={disabled}
            onChange={(command) => mutate("records", command, "Result")}
          />
        ) : (
          <Notice>
            Reports are unavailable for the current service account.
          </Notice>
        ))}
      {tab === "community" && (
        <>
          {community && communityActor ? (
            <ConnectedCommunity
              key={`${communityActor.accountId}:${communityActor.teamId}:${communityActor.seasonId}:${communityActor.role}`}
              value={community}
              actor={communityActor}
              media={
                new MediaUploadClient(
                  connection.baseUrl || "/",
                  communityActor,
                  authenticatedFetch,
                )
              }
              disabled={disabled}
              onChange={changeCommunity}
            />
          ) : (
            <Notice>
              Community is unavailable until the service grants current access.
            </Notice>
          )}
          {community?.allowed &&
            communityActor &&
            communityActor.role !== "spectator" &&
            community.matches[0] && (
              <MediaUpload
                actor={communityActor}
                apiBaseUrl={connection.baseUrl || "/"}
                synthetic={connection.mode === "synthetic"}
                allowLibraryPicker={props.allowSynthetic === false}
                matchId={community.matches[0].id}
                onChanged={reload}
              />
            )}
          <Card>
            <Text style={typography.section}>Accept an invitation</Text>
            <Text style={typography.body}>
              An invitation adds only its team and season grant. The service
              checks the code, expiry and current account.
            </Text>
            <Text style={typography.label}>Invitation destination</Text>
            <TextInput
              accessibilityLabel="Invitation team identifier"
              value={inviteTeamId}
              onChangeText={setInviteTeamId}
              placeholder={
                teamId ?? "Exact team identifier from the invitation"
              }
              autoCapitalize="none"
              autoCorrect={false}
              style={s.input}
            />
            <TextInput
              accessibilityLabel="Invitation season identifier"
              value={inviteSeasonId}
              onChangeText={setInviteSeasonId}
              placeholder={
                seasonId ?? "Exact season identifier from the invitation"
              }
              autoCapitalize="none"
              autoCorrect={false}
              style={s.input}
            />
            <Text style={typography.muted}>
              Enter the destination printed with the invitation. Leave a field
              blank only to use the current team or season shown above. The code
              grants no access until the service accepts it.
            </Text>
            <TextInput
              accessibilityLabel="Service invitation code"
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="none"
              autoCorrect={false}
              style={s.input}
            />
            <Button
              label="Accept service invitation"
              disabled={
                disabled ||
                !identity ||
                !inviteCode.trim() ||
                !(inviteTeamId.trim() || teamId) ||
                !(inviteSeasonId.trim() || seasonId)
              }
              onPress={() => {
                const destination = {
                  teamId: inviteTeamId.trim() || teamId || "",
                  seasonId: inviteSeasonId.trim() || seasonId || "",
                };
                void mutate(
                  "community",
                  {
                    id: randomUUID(),
                    type: "invite.accepted",
                    reviewCode: inviteCode.trim(),
                  },
                  "Invitation acceptance",
                  destination,
                ).then((saved) => {
                  if (!saved) return;
                  ++generation.current;
                  liveBinding.current = null;
                  setBinding(null);
                  setPreparation(null);
                  setOwn(null);
                  setRecords(null);
                  setCommunity(null);
                  setServiceMatchId("");
                  setScopeChoice(destination);
                });
              }}
            />
          </Card>
        </>
      )}
      {tab === "controller" && manager && props.journal && props.deviceId && (
        <View style={s.stack}>
          <Card>
            <Text style={typography.section}>Choose the service match</Text>
            <Text style={typography.body}>
              Open a prepared fixture or enter an existing accepted match
              identifier. The service checks its team, season and manager
              authority.
            </Text>
            <TextInput
              accessibilityLabel="Connected match identifier"
              value={serviceMatchId}
              onChangeText={setServiceMatchId}
              autoCapitalize="none"
              autoCorrect={false}
              style={s.input}
            />
            {preparation?.fixtures
              .filter((fixture) =>
                preparation.snapshots.some(
                  (snapshot) => snapshot.fixtureId === fixture.id,
                ),
              )
              .map((fixture) => (
                <Button
                  key={fixture.id}
                  label={`Control ${fixture.opponent} · ${fixture.playedDate}`}
                  variant={
                    serviceMatchId === fixture.id ? "primary" : "secondary"
                  }
                  onPress={() => setServiceMatchId(fixture.id)}
                />
              ))}
          </Card>
          {teamId && seasonId && serviceMatchId.trim() ? (
            <ServicePanel
              key={`${teamId}:${seasonId}:${serviceMatchId.trim()}`}
              journal={props.journal}
              deviceId={props.deviceId}
              match={
                props.match?.config.matchId === serviceMatchId.trim()
                  ? props.match
                  : null
              }
              matchId={serviceMatchId.trim()}
              teamId={teamId}
              seasonId={seasonId}
              allowSynthetic={props.allowSynthetic}
              onControllerState={props.onControllerState}
            />
          ) : (
            <Notice>
              Choose an existing service match before opening controller
              storage.
            </Notice>
          )}
        </View>
      )}
    </View>
  );
}

function OwnPreparation({
  value,
  disabled,
  onChange,
}: {
  value: OwnPreparationDto;
  disabled: boolean;
  onChange: (command: OwnCommand) => Promise<boolean>;
}) {
  const [preferences, setPreferences] = useState<PlayerProfile["preferences"]>([
    ...value.profile.preferences,
  ]);
  const command = (payload: OwnPayload) =>
    onChange({
      ...payload,
      id: randomUUID(),
      expectedRevision: value.revision,
    });
  const responseButtons = (
    response: AvailabilityResponse,
    save: (response: AvailabilityResponse) => void,
  ) => (
    <View style={s.row}>
      {(Object.keys(responseLabels) as AvailabilityResponse[]).map((option) => (
        <Button
          key={option}
          label={responseLabels[option]}
          variant={response === option ? "primary" : "secondary"}
          disabled={disabled}
          onPress={() => save(option)}
        />
      ))}
    </View>
  );
  return (
    <View style={s.stack} testID="workspace-own-preparation">
      <Card>
        <Text style={typography.section}>
          {value.profile.displayName} · my preferences
        </Text>
        <Text style={typography.muted}>
          {value.team.name} {value.team.ageGroup} · {value.season.label}
        </Text>
        <Text style={typography.body}>
          Choose three distinct positions in order. Goalkeeper eligibility is
          approved separately by a manager.
        </Text>
        {preferences.map((selected, rank) => (
          <View style={s.stack} key={rank}>
            <Text style={typography.label}>
              {["First", "Second", "Backup"][rank]} position
            </Text>
            <View style={s.row}>
              {positionCodes.map((position) => (
                <Button
                  key={position}
                  label={position}
                  variant={selected === position ? "primary" : "secondary"}
                  disabled={disabled}
                  onPress={() =>
                    setPreferences(
                      (current) =>
                        current.map((item, index) =>
                          index === rank ? position : item,
                        ) as PlayerProfile["preferences"],
                    )
                  }
                />
              ))}
            </View>
          </View>
        ))}
        <Button
          label="Save my position preferences to service"
          disabled={disabled || new Set(preferences).size !== 3}
          onPress={() => {
            void command({ type: "own.preferences_saved", preferences });
          }}
        />
      </Card>
      <Notice>
        Your reply, the manager’s selection and actual attendance are separate
        records. Your account can change its own reply; attendance is recorded
        by the manager.
      </Notice>
      {value.fixtures.map((fixture) => (
        <Card key={fixture.id}>
          <Text style={typography.section}>
            {fixture.homeAway === "away" ? "Away to" : "v"} {fixture.opponent}
          </Text>
          <Text style={typography.muted}>
            {fixture.playedDate} · {fixture.kickoff ?? "Time to confirm"} ·{" "}
            {fixture.venue} · {fixture.status}
          </Text>
          <Text style={typography.body}>
            {fixture.selected ? "Selected by manager" : "Not selected"} · actual
            attendance: {fixture.attendance.replaceAll("_", " ")}
          </Text>
          {fixture.status === "scheduled" ? (
            responseButtons(fixture.response, (response) => {
              void command({
                type: "own.fixture_response_recorded",
                fixtureId: fixture.id,
                response,
              });
            })
          ) : (
            <Text style={typography.muted}>
              Reply: {responseLabels[fixture.response]}
            </Text>
          )}
        </Card>
      ))}
      {value.training.map((training) => (
        <Card key={training.id}>
          <Text style={typography.section}>Training · {training.date}</Text>
          <Text style={typography.muted}>
            {training.time ?? "Time to confirm"} · {training.venue} ·{" "}
            {training.status}
          </Text>
          <Text style={typography.body}>
            {training.expected
              ? "Expected at this occurrence"
              : "Not in this occurrence"}{" "}
            · actual attendance: {training.attendance.replaceAll("_", " ")}
          </Text>
          {training.status === "scheduled" && training.expected ? (
            responseButtons(training.response, (response) => {
              void command({
                type: "own.training_response_recorded",
                trainingId: training.id,
                response,
              });
            })
          ) : (
            <Text style={typography.muted}>
              Reply: {responseLabels[training.response]}
            </Text>
          )}
        </Card>
      ))}
    </View>
  );
}

function ConnectedReports({
  value,
  manager,
  disabled,
  onChange,
}: {
  value: RecordsDto;
  manager: boolean;
  disabled: boolean;
  onChange: (command: RecordsCommand) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const report = value.matches.find((item) => item?.matchId === selected);
  return (
    <View style={s.stack} testID="workspace-reports">
      <Card>
        <Text style={typography.section}>Service results</Text>
        <Text style={typography.muted}>
          Projection {value.results.projectionVersion} · as of{" "}
          {value.results.asOf ?? "no completed recording"} ·{" "}
          {value.results.visibilityScope}
        </Text>
        {value.results.suppressionReason && (
          <Notice tone="warning">
            {value.results.suppressionReason} Q21 is unresolved; this screen
            cannot approve sharing.
          </Notice>
        )}
        {value.results.totals && (
          <Text style={typography.body}>
            {value.results.totals.played} played · {value.results.totals.wins}{" "}
            wins · {value.results.totals.draws} draws ·{" "}
            {value.results.totals.losses} losses ·{" "}
            {value.results.totals.goalsFor} for /{" "}
            {value.results.totals.goalsAgainst} against
          </Text>
        )}
        {value.results.rows.map((row) => (
          <View key={row.id} style={s.divider}>
            <Text style={typography.label}>
              {row.playedDate} · {row.opponent}
            </Text>
            <Text style={typography.body}>
              {row.finalScore
                ? `${row.finalScore.for} – ${row.finalScore.against}`
                : "Score not recorded"}{" "}
              · {row.status} · {row.detailCompleteness.replaceAll("_", " ")}
            </Text>
            <Button
              label={`Read service report for ${row.opponent}`}
              variant="quiet"
              onPress={() => setSelected(row.id)}
            />
          </View>
        ))}
        {manager && (
          <Button
            label="Add historical result to service"
            variant="secondary"
            disabled={disabled}
            onPress={() => setAdding((current) => !current)}
          />
        )}
      </Card>
      {adding && manager && (
        <HistoricalResultForm
          disabled={disabled}
          onSave={async (input) => {
            const saved = await onChange({
              type: "historical.add",
              commandId: randomUUID(),
              actor: "manager",
              at: new Date().toISOString(),
              recordId: randomUUID(),
              input,
            });
            if (saved) setAdding(false);
            return saved;
          }}
        />
      )}
      {report && (
        <Card>
          <Text style={typography.section}>
            {report.playedDate} · {report.opponent}
          </Text>
          <Text style={typography.body}>
            {report.score
              ? `${report.score.for} – ${report.score.against}`
              : (report.suppressionReason ?? "Score not recorded")}
          </Text>
          <Text style={typography.muted}>
            {report.recordMode.replaceAll("_", " ")} ·{" "}
            {report.detailCompleteness.replaceAll("_", " ")}
          </Text>
          {"participation" in report &&
            report.participation?.map((row) => (
              <Text key={row.playerId} style={typography.body}>
                {row.playerId} · {duration(row.playedMs)} played · GK{" "}
                {duration(row.positionMs.GK ?? 0)}
              </Text>
            ))}
          <Button
            label="Close service match report"
            variant="quiet"
            onPress={() => setSelected(null)}
          />
        </Card>
      )}
      <Card>
        <Text style={typography.section}>
          {manager ? "Squad participation" : "My participation"}
        </Text>
        {value.participation.reason && (
          <Notice>{value.participation.reason}</Notice>
        )}
        {value.participation.rows.map((row) => (
          <View key={row.playerId} style={s.divider}>
            <Text style={typography.label}>{row.label}</Text>
            <Text style={typography.body}>
              {row.matchesWithParticipationRecorded > 0
                ? `${duration(row.playingMs)} played · GK ${duration(row.goalkeeperMs)} · outfield ${duration(row.outfieldMs)}`
                : "Playing time and positions: not recorded"}
            </Text>
            <Text style={typography.muted}>
              Games attended {row.games.attendedCount}/
              {row.games.attendanceRecordedCount} recorded · training{" "}
              {row.training.attendedCount}/
              {row.training.attendanceRecordedCount} recorded
            </Text>
            <Text style={typography.muted}>{row.coverageLabel}</Text>
          </View>
        ))}
        {!value.participation.rows.length && !value.participation.reason && (
          <Text style={typography.muted}>
            No participation evidence returned.
          </Text>
        )}
      </Card>
    </View>
  );
}

function HistoricalResultForm({
  disabled,
  onSave,
}: {
  disabled: boolean;
  onSave: (input: HistoricalResultInput) => Promise<boolean>;
}) {
  const [date, setDate] = useState(""),
    [opponent, setOpponent] = useState(""),
    [goalsFor, setGoalsFor] = useState(""),
    [goalsAgainst, setGoalsAgainst] = useState("");
  const [homeAway, setHomeAway] =
    useState<HistoricalResultInput["homeAway"]>("home");
  const [fixtureClass, setFixtureClass] =
    useState<HistoricalResultInput["fixtureClass"]>("unclassified");
  return (
    <Card>
      <Text style={typography.section}>Record a past result</Text>
      <Text style={typography.body}>
        A summary result carries no invented lineups, minutes, attendance or
        award window. Sharing remains manager only until its competition policy
        is approved.
      </Text>
      {[
        ["Played date (YYYY-MM-DD)", date, setDate],
        ["Opponent", opponent, setOpponent],
        ["Goals for", goalsFor, setGoalsFor],
        ["Goals against", goalsAgainst, setGoalsAgainst],
      ].map(([label, text, setter]) => (
        <View key={label as string}>
          <Text style={typography.label}>{label as string}</Text>
          <TextInput
            accessibilityLabel={`Service result ${label}`}
            value={text as string}
            onChangeText={setter as (value: string) => void}
            style={s.input}
          />
        </View>
      ))}
      <View style={s.row}>
        {(["home", "away", "neutral"] as const).map((option) => (
          <Button
            key={option}
            label={option}
            variant={homeAway === option ? "primary" : "secondary"}
            disabled={disabled}
            onPress={() => setHomeAway(option)}
          />
        ))}
      </View>
      <View style={s.row}>
        {(["unclassified", "development", "friendly", "trophy"] as const).map(
          (option) => (
            <Button
              key={option}
              label={option}
              variant={fixtureClass === option ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => setFixtureClass(option)}
            />
          ),
        )}
      </View>
      <Button
        label="Save historical result to service"
        disabled={
          disabled ||
          !opponent.trim() ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !/^\d{1,2}$/.test(goalsFor) ||
          !/^\d{1,2}$/.test(goalsAgainst)
        }
        onPress={() => {
          void onSave({
            playedDate: date,
            opponent: opponent.trim(),
            homeAway,
            fixtureClass,
            recordedKickoff: null,
            sameDayOrder: null,
            status: "completed",
            specialOutcome: "ordinary",
            finalScore: {
              for: Number(goalsFor),
              against: Number(goalsAgainst),
            },
            halfTimeScore: null,
            goals: [],
          });
        }}
      />
    </Card>
  );
}

function ConnectedCommunity({
  value,
  actor,
  media,
  disabled,
  onChange,
}: {
  value: CommunityDto;
  actor: CommunityActor;
  media: MediaUploadClient;
  disabled: boolean;
  onChange: (command: CommunityPayload) => Promise<boolean>;
}) {
  const [cutoff, setCutoff] = useState("");
  const [reportReason, setReportReason] = useState("");
  const [confirmInvite, setConfirmInvite] = useState(false);
  const [viewed, setViewed] = useState<string[]>([]);
  const [photoAcknowledged, setPhotoAcknowledged] = useState(false);
  return (
    <View style={s.stack} testID="workspace-community">
      <Card>
        <Text style={typography.section}>{value.teamLabel} community</Text>
        <Text style={typography.muted}>
          {value.accountLabel} · {value.seasonLabel} · service revision{" "}
          {value.revision}
        </Text>
        {!value.allowed && (
          <Notice tone="warning">{value.accessMessage}</Notice>
        )}
        <Notice tone="warning">
          Q21 sharing policy is unresolved. Withheld match context, scores and
          derived awards remain withheld. Accepted match finish evidence and an
          approved policy are required before connected award registration.
        </Notice>
      </Card>
      {value.matches.map((match) => (
        <Card key={match.id}>
          <Text style={typography.section}>{match.label}</Text>
          {!match.sharingAllowed ? (
            <Notice>
              Match context is withheld by the service’s competition policy.
            </Notice>
          ) : (
            <>
              <Text style={typography.muted}>
                Full time: {dateTime(match.fullTimeAtMs)} · finish quality:{" "}
                {match.finishQuality}
              </Text>
              <Text style={typography.muted}>
                Voting closes: {dateTime(match.cutoffAtMs)} · finalisation
                deadline: {dateTime(match.deadlineAtMs)}
              </Text>
              {match.award && (
                <Text style={typography.body}>
                  {match.award.result === "no_valid_votes"
                    ? "No valid votes"
                    : `Players’ Player: ${match.award.winnerLabels.join(", ")}`}
                  {match.award.deadlineMissed
                    ? " · finalisation deadline missed"
                    : ""}
                </Text>
              )}
              {match.mayVote ? (
                <>
                  <Text style={typography.label}>
                    My Players’ Player choice
                  </Text>
                  {match.candidates.map((candidate) => (
                    <Button
                      key={candidate.id}
                      label={`${candidate.label}${match.ownChoice === candidate.id ? " · my current choice" : ""}`}
                      variant={
                        match.ownChoice === candidate.id
                          ? "primary"
                          : "secondary"
                      }
                      disabled={disabled}
                      onPress={() => {
                        void onChange({
                          type: "ballot.cast",
                          matchId: match.id,
                          candidatePlayerId: candidate.id,
                        });
                      }}
                    />
                  ))}
                </>
              ) : (
                actor.role === "player" && (
                  <Text style={typography.muted}>
                    Voting is unavailable for this account or match window.
                  </Text>
                )
              )}
              {actor.role === "manager" &&
                match.finishQuality === "trusted" &&
                match.fullTimeAtMs !== null &&
                !match.award && (
                  <>
                    <Text style={typography.label}>
                      Explicit cutoff, minutes after actual full time
                    </Text>
                    <TextInput
                      accessibilityLabel={`Award cutoff for ${match.label}`}
                      value={cutoff}
                      onChangeText={setCutoff}
                      keyboardType="number-pad"
                      style={s.input}
                    />
                    <Button
                      label="Save this explicit voting cutoff"
                      variant="secondary"
                      disabled={disabled || !/^\d{1,4}$/.test(cutoff)}
                      onPress={() => {
                        void onChange({
                          type: "award.cutoffConfigured",
                          matchId: match.id,
                          minutesAfterFullTime: Number(cutoff),
                        });
                      }}
                    />
                  </>
                )}
            </>
          )}
        </Card>
      ))}
      {actor.role !== "spectator" && (
        <Card>
          <Text style={typography.section}>Spectator invitations</Text>
          <Text style={typography.body}>
            Create a seven-day invitation code for this season. Access is
            checked and can be revoked; account membership elsewhere is
            retained.
          </Text>
          <Button
            label={
              confirmInvite
                ? "Invitation sharing acknowledged"
                : "Acknowledge sharing a limited season invitation"
            }
            variant={confirmInvite ? "primary" : "secondary"}
            disabled={disabled}
            onPress={() => setConfirmInvite((current) => !current)}
          />
          <Button
            label="Create service invitation code"
            disabled={disabled || !confirmInvite}
            onPress={() => {
              void onChange({
                type: "invite.created",
                invitationId: randomUUID(),
                reviewCode: randomUUID().replaceAll("-", "").slice(0, 20),
                expiresAtMs: Date.now() + 7 * 86_400_000,
              });
            }}
          />
          {value.invitations.map((invitation) => (
            <View key={invitation.id} style={s.divider}>
              <Text selectable style={typography.label}>
                Code: {invitation.reviewCode}
              </Text>
              <Text style={typography.muted}>
                {invitation.revokedAtMs
                  ? "Revoked"
                  : `Expires ${dateTime(invitation.expiresAtMs)}`}
              </Text>
              {!invitation.revokedAtMs && (
                <Button
                  label="Revoke this service invitation"
                  variant="danger"
                  disabled={disabled}
                  onPress={() => {
                    void onChange({
                      type: "invite.revoked",
                      invitationId: invitation.id,
                    });
                  }}
                />
              )}
            </View>
          ))}
          {value.grants.map((grant) => (
            <View key={grant.id} style={s.divider}>
              <Text style={typography.body}>
                {grant.accountLabel} · expires {dateTime(grant.expiresAtMs)}
              </Text>
              {!grant.revokedAtMs && (
                <Button
                  label={`Revoke ${grant.accountLabel} season grant`}
                  variant="danger"
                  disabled={disabled}
                  onPress={() => {
                    void onChange({ type: "grant.revoked", grantId: grant.id });
                  }}
                />
              )}
            </View>
          ))}
        </Card>
      )}
      <Card>
        <Text style={typography.section}>Service photo gallery</Text>
        {!value.gallery.length && (
          <Text style={typography.muted}>
            No published photos are visible in this service view.
          </Text>
        )}
        {value.gallery.map((photo) => (
          <View key={photo.id} style={s.divider}>
            <Text style={typography.label}>{photo.matchLabel}</Text>
            <Text style={typography.body}>{photo.caption}</Text>
            <Text style={typography.muted}>
              {photo.uploaderLabel} · revision {photo.version}
            </Text>
            <RemotePhoto
              key={`${photo.id}:${photo.version}:gallery`}
              client={media}
              photoId={photo.id}
              revision={photo.version}
              mode="gallery"
            />
            <Button
              label={`Hide photos from ${photo.uploaderLabel}`}
              variant="quiet"
              disabled={disabled}
              onPress={() => {
                void onChange({
                  type: "uploader.hidden",
                  uploaderAccountId: photo.uploaderAccountId,
                  hidden: true,
                });
              }}
            />
            <TextInput
              accessibilityLabel={`Concern about photo ${photo.id}`}
              value={reportReason}
              onChangeText={setReportReason}
              multiline
              placeholder="Explain a privacy or content concern"
              style={s.input}
            />
            <Button
              label="Report this photo to service review"
              variant="secondary"
              disabled={disabled || !reportReason.trim()}
              onPress={() => {
                void onChange({
                  type: "concern.submitted",
                  concernId: randomUUID(),
                  targetType: "photo",
                  targetId: photo.id,
                  category: "privacy",
                  explanation: reportReason.trim(),
                });
              }}
            />
            {actor.role === "manager" && (
              <Button
                label="Remove this published service photo"
                variant="danger"
                disabled={disabled}
                onPress={() => {
                  void onChange({ type: "photo.removed", photoId: photo.id });
                }}
              />
            )}
          </View>
        ))}
      </Card>
      {value.submissions.length > 0 && (
        <Card>
          <Text style={typography.section}>My service submissions</Text>
          {value.submissions.map((photo) => (
            <View key={photo.id} style={s.divider}>
              <Text style={typography.label}>
                {photo.caption || "Photo"} · revision {photo.version}
              </Text>
              <Text style={typography.body}>{photo.status}</Text>
              {["draft", "pending", "published"].includes(photo.status) && (
                <RemotePhoto
                  key={`${photo.id}:${photo.version}:own`}
                  client={media}
                  photoId={photo.id}
                  revision={photo.version}
                  mode="own"
                  onViewed={() =>
                    setViewed((current) => [
                      ...new Set([...current, `${photo.id}:${photo.version}`]),
                    ])
                  }
                />
              )}
              {actor.role === "manager" && photo.status === "draft" && (
                <>
                  <Button
                    label={
                      photoAcknowledged
                        ? "Photo and content rules reviewed"
                        : "Acknowledge reviewing this photo and content rules"
                    }
                    variant={photoAcknowledged ? "primary" : "secondary"}
                    disabled={disabled}
                    onPress={() => setPhotoAcknowledged((current) => !current)}
                  />
                  <Button
                    label="Publish this exact service photo revision"
                    disabled={
                      disabled ||
                      !photoAcknowledged ||
                      !viewed.includes(`${photo.id}:${photo.version}`)
                    }
                    onPress={() => {
                      void onChange({
                        type: "photo.published",
                        photoId: photo.id,
                        sourceRevision: photo.version,
                        policyAcknowledged: true,
                      });
                    }}
                  />
                </>
              )}
              {photo.rejectionReason && (
                <Notice tone="warning">{photo.rejectionReason}</Notice>
              )}
              {["draft", "pending", "published"].includes(photo.status) && (
                <Button
                  label="Withdraw this service submission"
                  variant="danger"
                  disabled={disabled}
                  onPress={() => {
                    void onChange({
                      type: "photo.withdrawn",
                      photoId: photo.id,
                      sourceRevision: photo.version,
                    });
                  }}
                />
              )}
            </View>
          ))}
        </Card>
      )}
      {actor.role === "manager" && value.reviewQueue.length > 0 && (
        <Card>
          <Text style={typography.section}>Private photo review</Text>
          <Text style={typography.body}>
            Approval checks this exact revision. A later edit needs its own
            review.
          </Text>
          {value.reviewQueue.map((photo) => (
            <View key={`${photo.id}:${photo.version}`} style={s.divider}>
              <Text style={typography.label}>
                {photo.uploaderLabel} · revision {photo.version}
              </Text>
              <Text style={typography.body}>{photo.caption}</Text>
              <RemotePhoto
                key={`${photo.id}:${photo.version}:review`}
                client={media}
                photoId={photo.id}
                revision={photo.version}
                mode="review"
                onViewed={() =>
                  setViewed((current) => [
                    ...new Set([...current, `${photo.id}:${photo.version}`]),
                  ])
                }
              />
              <Button
                label="Approve this exact service photo revision"
                disabled={
                  disabled || !viewed.includes(`${photo.id}:${photo.version}`)
                }
                onPress={() => {
                  void onChange({
                    type: "photo.reviewed",
                    photoId: photo.id,
                    sourceRevision: photo.version,
                    decision: "approve",
                  });
                }}
              />
              <TextInput
                accessibilityLabel={`Photo rejection reason ${photo.id}`}
                value={reportReason}
                onChangeText={setReportReason}
                placeholder="Reason for rejection"
                style={s.input}
              />
              <Button
                label="Reject this exact service photo revision"
                variant="danger"
                disabled={disabled || !reportReason.trim()}
                onPress={() => {
                  void onChange({
                    type: "photo.reviewed",
                    photoId: photo.id,
                    sourceRevision: photo.version,
                    decision: "reject",
                    reason: reportReason.trim(),
                  });
                }}
              />
            </View>
          ))}
        </Card>
      )}
      {value.reviewConcerns.map((concern) => (
        <Card key={concern.id}>
          <Text style={typography.section}>
            Content concern · {concern.category}
          </Text>
          <Text style={typography.body}>{concern.explanation}</Text>
          <Text style={typography.muted}>{concern.status}</Text>
          <Button
            label="Mark concern under service review"
            variant="secondary"
            disabled={disabled}
            onPress={() => {
              void onChange({
                type: "concern.updated",
                concernId: concern.id,
                status: "under_review",
              });
            }}
          />
          <Button
            label="Resolve service concern"
            disabled={disabled}
            onPress={() => {
              void onChange({
                type: "concern.updated",
                concernId: concern.id,
                status: "resolved",
              });
            }}
          />
        </Card>
      ))}
      {value.hiddenUploaders.length > 0 && (
        <Card>
          <Text style={typography.section}>Hidden uploaders</Text>
          {value.hiddenUploaders.map((person) => (
            <Button
              key={person.id}
              label={`Show ${person.label} again`}
              variant="secondary"
              disabled={disabled}
              onPress={() => {
                void onChange({
                  type: "uploader.hidden",
                  uploaderAccountId: person.id,
                  hidden: false,
                });
              }}
            />
          ))}
        </Card>
      )}
    </View>
  );
}

function RemotePhoto({
  client,
  photoId,
  revision,
  mode,
  onViewed,
}: {
  client: MediaUploadClient;
  photoId: string;
  revision: number;
  mode: "own" | "gallery" | "review";
  onViewed?: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  return (
    <View style={s.stack}>
      <Button
        label={
          busy
            ? "Checking current image access…"
            : "View authorised service image"
        }
        variant="secondary"
        disabled={busy}
        onPress={() => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError(null);
          setUri(null);
          void client
            .image(photoId, revision, "display", mode)
            .then((bytes) => {
              const encoded = base64Url(bytes)
                .replaceAll("-", "+")
                .replaceAll("_", "/");
              setUri(
                `data:image/jpeg;base64,${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`,
              );
              onViewed?.();
            })
            .catch((cause) => setError(failureText(cause)))
            .finally(() => {
              lock.current = false;
              setBusy(false);
            });
        }}
      />
      {error && <Notice tone="warning">{error}</Notice>}
      {uri && (
        <>
          <Image
            source={{ uri, cache: "reload" }}
            accessibilityLabel={`Authorised service photo revision ${revision}`}
            style={{
              width: "100%",
              height: 240,
              resizeMode: "contain",
              backgroundColor: colors.bench,
            }}
          />
          <Button
            label="Close service image"
            variant="quiet"
            onPress={() => setUri(null)}
          />
          <Text style={typography.muted}>
            This derivative is held in memory. The service checks current access
            on each fetch; it cannot recall an existing screenshot.
          </Text>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    backgroundColor: colors.surface,
    color: colors.ink,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
});
