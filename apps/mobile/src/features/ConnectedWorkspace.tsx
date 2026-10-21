import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  Image,
  Platform,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  currentMemberships,
  type Membership,
  type Principal,
  type Role,
} from "@longball/application/access";
import {
  createWorkspaceContextPreference,
  resolveWorkspaceContext,
  workspaceContextChoices,
  workspaceContextKey,
  workspaceContextPreferenceKey,
  type WorkspaceContextSelection,
} from "@longball/application/workspace-context";
import {
  mergeWorkspaceControllerStatus,
  workspaceNavigationDecision,
} from "@longball/application/workspace-navigation";
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
  BrandingDto,
  BrandingCommand,
} from "@longball/application/branding";
import {
  BrandMediaClient,
  assertBrandingResponse,
} from "../platform/brand-media-client";
import { ScopedWorkspaceInvitations } from "./ScopedWorkspaceInvitations";
import { BrandLogos } from "./BrandLogos";
import { AuthenticatedBrandBadge } from "./BrandBadge";
import type { RecordsCommand } from "@longball/application/records";
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
  workspaceNeedsProtectedOutbox,
  workspaceSessionAllows,
  type BoundWorkspaceValue,
  type WorkspaceBinding,
} from "@longball/application/workspace-boundary";
import {
  albumScopeKey,
  resolveAlbumSelection,
  selectAlbum,
  type AlbumScope,
  type AlbumSelection,
} from "@longball/application/album-selection";
import { assertStaticReviewApiAddress } from "@longball/application/static-review";
import { base64Url } from "@longball/application/security";
import { MediaUploadClient } from "../platform/media-client";
import { selectedRoleHeaders } from "../platform/request-headers";
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
import {
  ServicePanel,
  type ConnectedControllerState,
  type ServicePanelProps,
} from "./ServicePanel";
import { MediaUpload } from "./MediaUpload";
import { ConnectedAlbums } from "./ConnectedAlbums";
import {
  ConnectedMatchCentre,
  type ConnectedMatchCentreDto,
} from "./ConnectedMatchCentre";
import { ConnectedManagerHome } from "./ConnectedManagerHome";
import { groupPreparationEvents } from "@longball/application/preparation-presentation";
import { ConnectedPlayerHome } from "./ConnectedPlayerHome";
import { WorkspaceNavigation, type WorkspaceTab } from "./WorkspaceNavigation";
import {
  ConnectedRecordsScreens,
  type ConnectedRecordsDto,
  type ConnectedRecordsCommand,
  type ConnectedExportRequest,
} from "./ConnectedRecordsScreens";
import {
  ConnectedSeasonRollover,
  type ConnectedSeasonOptions,
} from "./ConnectedSeasonRollover";
import {
  ConnectedClubConfiguration,
  type ConnectedConfigurationDto,
} from "./ConnectedClubConfiguration";
import {
  ConnectedStaffPanel,
  type ConnectedStaffDto,
  type ConnectedStaffCommand,
} from "./ConnectedStaffPanel";
import type { SeasonRolloverCommand } from "@longball/application/season-service";
import { deliverReportExport } from "../platform/report-export";
import { assertReportExportAccess } from "../platform/report-export-access";
import {
  WorkspaceOutboxBridge,
  type WorkspaceOutboxPort,
  type WorkspaceOutboxStatus,
} from "./WorkspaceOutboxBridge";

export interface ConnectedWorkspaceProps {
  initialConnection?: {
    baseUrl: string;
    mode: "synthetic" | "oidc";
    account: string;
  };
  initialRole?: Role;
  onLeaveWorkspace?: () => void;
  onOpenAccount?: () => void;
  /** Keeps the workspace mounted while an exit warning or a retained capability is reviewed. */
  onNavigationGuardChange?: (
    guard: ((leave: () => void) => void) | null,
  ) => void;
  allowSynthetic?: boolean;
  journal?: Journal | null;
  deviceId?: string | null;
  match?: MatchState | null;
  teamId?: string;
  seasonId?: string;
  onControllerState?: ServicePanelProps["onControllerState"];
  invitationDestination?: { teamId: string; seasonId: string; code: string };
  /** Internal retention signal; local locking and sign-out always remain available. */
  onEphemeralRetainedChange?: (retained: boolean, owner: string) => void;
  onPrepareChildActivation?: (scope: {
    teamId: string;
    seasonId: string;
    playerId: string;
  }) => void;
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
type RecordsDto = ConnectedRecordsDto;
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
type Tab = WorkspaceTab;
interface PendingRequest {
  path: string;
  key: string;
  body: unknown;
  label: string;
  bodyJson?: string;
  protected?: boolean;
}
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
// Service handlers read fresh authority time after awaited network/vault work.
const serviceActionTime = () => Date.now();
const dateTime = (ms: number | null) =>
  ms === null ? "Not established" : new Date(ms).toLocaleString("en-GB");

async function contextPreferenceStorageKey(api: string, principal: Principal) {
  const namespace = workspaceContextPreferenceKey(api, principal);
  if (Platform.OS === "web") return namespace;
  return `longball.context.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, namespace)}`;
}
async function readContextPreference(
  api: string,
  principal: Principal,
): Promise<unknown> {
  try {
    const key = await contextPreferenceStorageKey(api, principal);
    const raw =
      Platform.OS === "web"
        ? globalThis.localStorage.getItem(key)
        : await SecureStore.getItemAsync(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
async function saveContextPreference(
  api: string,
  principal: Principal,
  selection: WorkspaceContextSelection,
): Promise<void> {
  const key = await contextPreferenceStorageKey(api, principal);
  const encoded = JSON.stringify(
    createWorkspaceContextPreference(api, principal, selection),
  );
  if (Platform.OS === "web") globalThis.localStorage.setItem(key, encoded);
  else
    await SecureStore.setItemAsync(key, encoded, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
}

/** Reads and commands go to the service; this screen does not grant roles or seed its own remote records. */
export function ConnectedWorkspace(props: ConnectedWorkspaceProps) {
  const allowSynthetic =
    props.allowSynthetic ??
    process.env.EXPO_PUBLIC_ENVIRONMENT !== "production";
  const staticBrowser =
    Platform.OS === "web" && process.env.EXPO_PUBLIC_REVIEW_STATIC === "1";
  const [baseUrl, setBaseUrl] = useState(
    process.env.EXPO_PUBLIC_API_BASE_URL ||
      (staticBrowser
        ? ""
        : Platform.OS === "web"
          ? "/"
          : "http://127.0.0.1:4310"),
  );
  const [mode, setMode] = useState<Connection["mode"]>("oidc");
  const [account, setAccount] = useState("synthetic-manager-1");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retained, setRetained] = useState<{
    owner: string;
    active: boolean;
  } | null>(null);
  const externalRetainedChange = useRef(props.onEphemeralRetainedChange);
  useLayoutEffect(() => {
    externalRetainedChange.current = props.onEphemeralRetainedChange;
  }, [props.onEphemeralRetainedChange]);
  const retainedRef = useRef<{ owner: string; active: boolean } | null>(null);
  const onEphemeralRetainedChange = useCallback(
    (active: boolean, owner: string) => {
      if (!active && retainedRef.current?.owner !== owner) return;
      const value = active ? { owner, active } : null;
      retainedRef.current = value;
      setRetained(value);
      externalRetainedChange.current?.(active, owner);
    },
    [],
  );
  const connectionHeld = retained?.active === true;
  const initialBaseUrl = props.initialConnection?.baseUrl;
  const initialMode = props.initialConnection?.mode;
  const initialAccount = props.initialConnection?.account;
  const supplied = useMemo(() => {
    if (
      !initialMode ||
      initialBaseUrl === undefined ||
      initialAccount === undefined
    )
      return { connection: null, error: null };
    try {
      const value = {
        baseUrl: initialBaseUrl,
        mode: initialMode,
        account: initialAccount,
      };
      if (value.mode === "synthetic" && !allowSynthetic)
        throw new Error(
          "Fictional identities are disabled in this application.",
        );
      assertStaticReviewApiAddress(
        value.baseUrl,
        staticBrowser,
        Platform.OS === "web" ? globalThis.location.origin : undefined,
      );
      const validated = new LongBallServiceClient(value.baseUrl, async () => {
        throw new Error("Not connected.");
      });
      return {
        connection: { ...value, baseUrl: validated.baseUrl },
        error: null,
      };
    } catch (cause) {
      return { connection: null, error: failureText(cause) };
    }
  }, [
    initialBaseUrl,
    initialMode,
    initialAccount,
    allowSynthetic,
    staticBrowser,
  ]);
  const activeConnection = props.initialConnection
    ? supplied.connection
    : connection;
  return (
    <View style={s.stack} testID="connected-workspace">
      {!props.initialConnection && (
        <Card>
          <Text style={typography.section}>Service workspace</Text>
          <Text style={typography.body}>
            Open the team held by the service. Saved changes can be read on
            another connected device.
          </Text>
          {staticBrowser && (
            <Notice>
              This lasting review link runs fictional journeys stored in this
              browser. Connected service features need an explicit API address
              or the separate temporary full-service link supplied for review.
              This static site does not host the API.
            </Notice>
          )}
          <Text style={typography.label}>API URL</Text>
          <TextInput
            accessibilityLabel="Workspace API URL"
            value={baseUrl}
            editable={!connectionHeld}
            onChangeText={(value) => {
              if (!retainedRef.current?.active) setBaseUrl(value);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            style={s.input}
          />
          <View style={s.row}>
            <Button
              label="Connected sign-in"
              variant={mode === "oidc" ? "primary" : "secondary"}
              disabled={connectionHeld}
              onPress={() => {
                if (!retainedRef.current?.active) setMode("oidc");
              }}
            />
            {allowSynthetic && (
              <Button
                label="Fictional API review"
                variant={mode === "synthetic" ? "primary" : "secondary"}
                disabled={connectionHeld}
                onPress={() => {
                  if (!retainedRef.current?.active) setMode("synthetic");
                }}
              />
            )}
          </View>
          {mode === "oidc" ? (
            <Notice>
              Sign in under Account security first. Its unlocked credential is
              sent only to its configured API. Roles and adult authority come
              from that service.
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
                  ["synthetic-admin", "Fictional administrator"],
                  ["synthetic-manager-2", "Fictional manager only"],
                  ["synthetic-account-player-01", "Fictional Player 01"],
                  ["synthetic-spectator", "Fictional spectator"],
                  ["synthetic-account-invitee", "Fictional invite recipient"],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    label={label}
                    variant={account === value ? "primary" : "secondary"}
                    disabled={connectionHeld}
                    onPress={() => {
                      if (!retainedRef.current?.active) setAccount(value);
                    }}
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
            {staticBrowser
              ? "Paste the separately supplied full API address. The static review site address and / cannot be used as an API."
              : "Browser review: use / with the combined app/API server. The standalone API uses port 4310. A physical phone needs the development host address or a USB port mapping."}
          </Text>
          {error && <Notice tone="error">{error}</Notice>}
          <Button
            label="Open service workspace"
            testID="workspace-connect"
            disabled={connectionHeld}
            onPress={() => {
              if (retainedRef.current?.active) return;
              try {
                if (mode === "synthetic" && !allowSynthetic)
                  throw new Error(
                    "Fictional API identities are disabled in this build.",
                  );
                assertStaticReviewApiAddress(
                  baseUrl,
                  staticBrowser,
                  Platform.OS === "web"
                    ? globalThis.location.origin
                    : undefined,
                );
                const validated = new LongBallServiceClient(
                  baseUrl,
                  async () => {
                    throw new Error("Not connected.");
                  },
                );
                setConnection({ baseUrl: validated.baseUrl, mode, account });
                setError(null);
              } catch (cause) {
                setError(failureText(cause));
              }
            }}
          />
        </Card>
      )}
      {supplied.error && (
        <Card>
          <Notice tone="error">{supplied.error}</Notice>
          {props.onLeaveWorkspace && (
            <Button
              label="Return to welcome"
              onPress={props.onLeaveWorkspace}
            />
          )}
        </Card>
      )}
      {activeConnection &&
        (activeConnection.mode !== "synthetic" || allowSynthetic) && (
          <WorkspaceEntry
            key={`${activeConnection.baseUrl}|${activeConnection.mode}|${activeConnection.account}|${props.teamId}|${props.seasonId}`}
            connection={activeConnection}
            {...props}
            allowSynthetic={allowSynthetic}
            onEphemeralRetainedChange={onEphemeralRetainedChange}
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
  onEphemeralRetainedChange,
  ...props
}: ConnectedWorkspaceProps & {
  connection: Connection;
  oidcSession?: ConnectedSessionSummary;
}) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const lock = useRef(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [retainedOwner] = useState(randomUUID);
  const brandRetainedRef = useRef(false),
    brandScopeRef = useRef<string | null>(null);
  const uploadRetainedRef = useRef(false);
  const albumKeyRef = useRef<string | null>(null);
  const invitationAuthority = useRef<string | null>(null);
  const invitationHeldRef = useRef<{
    scopeKey: string;
    active: boolean;
  } | null>(null);

  const [membershipTime, setMembershipTime] = useState(Date.now);
  const [scopeChoice, setScopeChoice] = useState<{
    teamId: string;
    seasonId: string;
    playerId?: string | null;
  } | null>(null);
  const [roleChoice, setRoleChoice] = useState<WorkspaceBinding["role"] | null>(
    null,
  );
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [navigationReview, setNavigationReview] = useState<(() => void) | null>(
    null,
  );
  const [controllerStatus, setControllerStatus] = useState<{
    source: string;
    state: ConnectedControllerState;
  } | null>(null);
  const controllerStatusRef = useRef<{
    source: string;
    state: ConnectedControllerState;
  } | null>(null);
  const controllerStateSink = useRef(props.onControllerState);
  useLayoutEffect(() => {
    controllerStateSink.current = props.onControllerState;
  }, [props.onControllerState]);
  const navigationStateRef = useRef<{
    memoryPending: boolean;
    savedPending: boolean;
    controllerPending: boolean;
    controllerUnsent: boolean;
  }>({
    memoryPending: false,
    savedPending: false,
    controllerPending: false,
    controllerUnsent: false,
  });
  const onNavigationGuardChange = props.onNavigationGuardChange;
  const guardNavigation = useCallback((leave: () => void) => {
    const current = navigationStateRef.current;
    const decision = workspaceNavigationDecision({
      ...current,
      privateCapability:
        brandRetainedRef.current ||
        uploadRetainedRef.current ||
        Boolean(invitationHeldRef.current?.active),
      busy: lock.current,
    });
    if (decision === "blocked") {
      setErrors([
        "Retry or explicitly close the retained private request before changing workspace. Its current capability stays on this screen. Account locking and sign-out remain available.",
      ]);
      return;
    }
    if (decision === "review_saved") {
      setNavigationReview(() => leave);
      return;
    }
    leave();
  }, []);
  useLayoutEffect(() => {
    onNavigationGuardChange?.(guardNavigation);
    return () => onNavigationGuardChange?.(null);
  }, [guardNavigation, onNavigationGuardChange]);
  const [preparationCache, setPreparation] =
    useState<BoundWorkspaceValue<PreparationState> | null>(null);
  const [ownCache, setOwn] =
    useState<BoundWorkspaceValue<OwnPreparationDto> | null>(null);
  const [recordsCache, setRecords] =
    useState<BoundWorkspaceValue<RecordsDto> | null>(null);
  const [communityCache, setCommunity] =
    useState<BoundWorkspaceValue<CommunityDto> | null>(null);
  const [matchesCache, setMatches] = useState<BoundWorkspaceValue<
    ConnectedMatchCentreDto[]
  > | null>(null);
  const [seasonCache, setSeasons] =
    useState<BoundWorkspaceValue<ConnectedSeasonOptions> | null>(null);
  const [configurationCache, setConfiguration] =
    useState<BoundWorkspaceValue<ConnectedConfigurationDto> | null>(null);
  const [staffCache, setStaff] =
    useState<BoundWorkspaceValue<ConnectedStaffDto> | null>(null);
  const [brandingCache, setBranding] =
    useState<BoundWorkspaceValue<BrandingDto> | null>(null);
  const [brandRetained, setBrandRetained] = useState(false);
  const onBrandRetained = useCallback(
    (active: boolean, scopeKey: string) => {
      if (brandScopeRef.current !== scopeKey) return;
      brandRetainedRef.current = active;
      setBrandRetained(active);
      onEphemeralRetainedChange?.(
        active ||
          uploadRetainedRef.current ||
          Boolean(
            invitationHeldRef.current?.active &&
              invitationHeldRef.current.scopeKey ===
                invitationAuthority.current,
          ),
        retainedOwner,
      );
    },
    [onEphemeralRetainedChange, retainedOwner],
  );
  const [albumSelection, setAlbumSelection] = useState<AlbumSelection | null>(
    null,
  );
  const [uploadRetained, setUploadRetained] = useState(false);
  const onUploadRetained = useCallback(
    (active: boolean, scopeKey: string) => {
      if (albumKeyRef.current !== scopeKey) return;
      uploadRetainedRef.current = active;
      setUploadRetained(active);
      onEphemeralRetainedChange?.(
        active ||
          brandRetainedRef.current ||
          Boolean(
            invitationHeldRef.current?.active &&
              invitationHeldRef.current.scopeKey ===
                invitationAuthority.current,
          ),
        retainedOwner,
      );
    },
    [onEphemeralRetainedChange, retainedOwner],
  );
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);
  const generation = useRef(0);
  const liveBinding = useRef<WorkspaceBinding | null>(null);
  const invalidateRequests = useCallback(() => {
    ++generation.current;
    liveBinding.current = null;
  }, []);
  const [tab, setTab] = useState<Tab>("home");
  const [communityInitialSection, setCommunityInitialSection] = useState<
    "photos" | "awards"
  >("photos");
  const [selectedReportMatchId, setSelectedReportMatchId] = useState<
    string | null
  >(null);
  const initialRoute = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [memoryPending, setPending] = useState<PendingRequest | null>(null);
  const [legacyReviewKey, setLegacyReviewKey] = useState<string | null>(null);
  const [outboxStatus, setOutboxStatus] =
    useState<WorkspaceOutboxStatus | null>(null);
  const outboxPort = useRef<WorkspaceOutboxPort | null>(null);
  const [storage, setStorage] = useState<{
    journal: Journal;
    diagnostics: JournalDiagnostics;
  } | null>(null);
  const [invitationHeld, setInvitationHeld] = useState<{
    scopeKey: string;
    active: boolean;
  } | null>(null);
  const onInvitationRetained = useCallback(
    (active: boolean, scopeKey: string) => {
      if (invitationAuthority.current !== scopeKey) return;
      const next = { scopeKey, active };
      invitationHeldRef.current = next;
      setInvitationHeld(next);
      onEphemeralRetainedChange?.(
        active || brandRetainedRef.current || uploadRetainedRef.current,
        retainedOwner,
      );
    },
    [onEphemeralRetainedChange, retainedOwner],
  );
  const [serviceMatchId, setServiceMatchId] = useState(
    props.match?.config.matchId ?? "",
  );
  const oidcSessionId = oidcSession?.sessionId;
  const oidcAccountId = oidcSession?.accountId;
  const oidcIssuer = oidcSession?.issuer;
  const oidcSubject = oidcSession?.subject;
  const contextChoices = identity
    ? workspaceContextChoices(
        identity.principal,
        identity.memberships,
        membershipTime,
      )
    : [];
  const selectedContext =
    scopeChoice && roleChoice
      ? (contextChoices.find(
          (item) =>
            item.teamId === scopeChoice.teamId &&
            item.seasonId === scopeChoice.seasonId &&
            item.role === roleChoice &&
            (item.role !== "player" || item.playerId === scopeChoice.playerId),
        ) ?? null)
      : null;
  const teamId = selectedContext?.teamId;
  const seasonId = selectedContext?.seasonId;
  const path = (section: string) => {
    if (!teamId || !seasonId)
      throw new Error("The service has not granted a team and season scope.");
    return `/v1/teams/${encodeURIComponent(teamId)}/${section}?seasonId=${encodeURIComponent(seasonId)}`;
  };
  const authenticatedFetch = useMemo<
    (url: string, options: RequestInit) => Promise<Response>
  >(
    () => async (url, options) => {
      const requestOptions = {
        ...options,
        headers: selectedRoleHeaders(options.headers, roleChoice),
      };
      if (connection.mode === "oidc") {
        const absolute =
          url.startsWith("/") && Platform.OS === "web"
            ? new URL(url, globalThis.location.origin).toString()
            : url;
        return connectedFetch(absolute, requestOptions);
      }
      return fetch(url, {
        ...requestOptions,
        redirect: "error",
        headers: {
          ...requestOptions.headers,
          Authorization: `Bearer ${connection.account}`,
        },
      });
    },
    [connection, roleChoice],
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
  const controllerSource = `${absoluteApi}\u0000${identity?.principal.accountId}\u0000${identity?.principal.issuer}\u0000${identity?.principal.subject}\u0000${teamId}\u0000${seasonId}\u0000${roleChoice}\u0000${serviceMatchId}`;
  const currentControllerSource = useRef(controllerSource);
  useLayoutEffect(() => {
    currentControllerSource.current = controllerSource;
  }, [controllerSource]);
  const handleControllerState = useCallback(
    (state: ConnectedControllerState) => {
      const previous = controllerStatusRef.current;
      const next = mergeWorkspaceControllerStatus(
        currentControllerSource.current,
        previous,
        controllerSource,
        state,
      );
      if (!next || next === previous) return;
      if (
        previous?.source === next.source &&
        JSON.stringify(previous.state) === JSON.stringify(next.state)
      )
        return;
      controllerStatusRef.current = next;
      setControllerStatus(next);
      controllerStateSink.current?.(next.state);
    },
    [controllerSource],
  );
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
  const pending = useMemo<PendingRequest | null>(
    () =>
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
        : null),
    [memoryPending, restored],
  );
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
  const membership = selectedContext
    ? actor.find(
        (item) =>
          item.role === selectedContext.role &&
          (item.role !== "player" ||
            item.playerId === selectedContext.playerId),
      )
    : undefined;
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
    binding?.teamId === teamId &&
    binding?.seasonId === seasonId &&
    binding?.role === membership?.role
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
  const matches = readWorkspaceValue(
    matchesCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const seasonOptions = readWorkspaceValue(
    seasonCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const configuration = readWorkspaceValue(
    configurationCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const staff = readWorkspaceValue(
    staffCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const branding = readWorkspaceValue(
    brandingCache,
    expectedBinding,
    identity?.principal ?? null,
    identity?.memberships ?? [],
    membershipTime,
  );
  const brandRole = membership?.role,
    brandClubId = branding?.clubId;
  const brandClient =
    teamId && seasonId && brandRole
      ? new BrandMediaClient(
          connection.baseUrl || "/",
          {
            teamId,
            authoritySeasonId: seasonId,
            role: brandRole,
            clubId: brandClubId,
          },
          authenticatedFetch,
        )
      : null;
  const brandScopeKey = expectedBinding
    ? JSON.stringify([
        `${absoluteApi}`,
        expectedBinding.accountId,
        expectedBinding.issuer,
        expectedBinding.subject,
        expectedBinding.teamId,
        expectedBinding.seasonId,
        expectedBinding.role,
        expectedBinding.playerId,
      ])
    : null;
  useLayoutEffect(() => {
    if (brandScopeKey) brandScopeRef.current = brandScopeKey;
  }, [brandScopeKey]);
  const assertBrandAccess = async () => {
    if (!expectedBinding)
      throw new Error("Open a current authorised logo scope first.");
    await assertReportExportAccess({
      source: expectedBinding,
      currentBinding: () => liveBinding.current,
      principal: identity?.principal ?? null,
      memberships: identity?.memberships ?? [],
      nowMs: Date.now,
      session:
        connection.mode === "oidc"
          ? {
              requiredSessionId: oidcSessionId ?? "",
              read: getConnectedSessionSummary,
            }
          : null,
    });
  };
  const administrator =
    membership?.role === "administrator" &&
    workspaceBindingIsCurrent(
      expectedBinding,
      identity?.principal ?? null,
      identity?.memberships ?? [],
      membershipTime,
    );
  const invitationRole =
    membership &&
    workspaceBindingIsCurrent(
      expectedBinding,
      identity?.principal ?? null,
      identity?.memberships ?? [],
      membershipTime,
    )
      ? membership.role
      : null;
  const invitationScopeKey = identity
    ? JSON.stringify([
        `${absoluteApi}`,
        identity.principal.accountId,
        identity.principal.issuer,
        identity.principal.subject,
        oidcSessionId ?? "synthetic-review",
        teamId ?? null,
        seasonId ?? null,
        invitationRole,
      ])
    : null;
  const invitationRetained = Boolean(
    invitationScopeKey &&
      invitationHeld?.scopeKey === invitationScopeKey &&
      invitationHeld.active,
  );
  useEffect(() => {
    onEphemeralRetainedChange?.(
      uploadRetained || brandRetained || invitationRetained,
      retainedOwner,
    );
  }, [
    uploadRetained,
    brandRetained,
    invitationRetained,
    onEphemeralRetainedChange,
    retainedOwner,
  ]);
  useEffect(
    () => () => onEphemeralRetainedChange?.(false, retainedOwner),
    [onEphemeralRetainedChange, retainedOwner],
  );
  useLayoutEffect(() => {
    invitationAuthority.current = invitationScopeKey;
    return () => {
      invitationAuthority.current = null;
    };
  }, [invitationScopeKey]);
  const invitationIsRetained = () =>
    Boolean(
      invitationAuthority.current &&
        invitationHeldRef.current?.scopeKey === invitationAuthority.current &&
        invitationHeldRef.current.active,
    );
  const assertInvitationCurrent = () => {
    if (
      !identity ||
      identity.principal.status !== "active" ||
      !invitationScopeKey ||
      invitationAuthority.current !== invitationScopeKey ||
      (connection.mode === "oidc" &&
        (!oidcSession ||
          !workspaceSessionAllows(
            oidcSession,
            absoluteApi,
            serviceActionTime(),
          ) ||
          oidcSession.sessionId !== oidcSessionId ||
          oidcSession.accountId !== identity.principal.accountId ||
          oidcSession.issuer !== identity.principal.issuer ||
          oidcSession.subject !== identity.principal.subject))
    )
      throw new Error(
        "The verified invitation identity or scope changed. Reopen the current account; no credential was retained.",
      );
    if (
      invitationRole &&
      !workspaceBindingIsCurrent(
        expectedBinding,
        identity.principal,
        identity.memberships,
        serviceActionTime(),
      )
    )
      throw new Error(
        "Current team access changed. Refresh before managing invitations.",
      );
  };
  const communityActor: CommunityActor | null =
    identity &&
    membership &&
    membership.role !== "administrator" &&
    teamId &&
    seasonId
      ? {
          accountId: identity.principal.accountId,
          teamId,
          seasonId,
          role: membership.role as CommunityActor["role"],
          playerId: membership.playerId,
        }
      : null;

  const albumScope: AlbumScope | null =
    communityActor && identity
      ? {
          apiBaseUrl: `${absoluteApi}`,
          accountId: identity.principal.accountId,
          issuer: identity.principal.issuer,
          subject: identity.principal.subject,
          teamId: communityActor.teamId,
          seasonId: communityActor.seasonId,
          role: communityActor.role,
          playerId: communityActor.playerId,
        }
      : null;
  const albumKey = albumScope ? albumScopeKey(albumScope) : null;
  // Keep the stable choice above refreshable DTO children; permission is resolved on every render.
  useLayoutEffect(() => {
    if (albumKey) albumKeyRef.current = albumKey;
  }, [albumKey]);
  const selectedAlbum =
    albumScope && community
      ? resolveAlbumSelection(
          albumScope,
          community.matches,
          albumSelection,
          community.allowed,
        )
      : null;
  const openAlbum = (matchId: string) => {
    try {
      if (!albumScope || !community)
        throw new Error("Refresh the current permitted game albums first.");
      setAlbumSelection(
        selectAlbum(albumScope, community.matches, matchId, community.allowed),
      );
      setCommunityInitialSection("photos");
      setTab("community");
    } catch (cause) {
      setErrors([failureText(cause)]);
    }
  };

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
    setMatches(null);
    setSeasons(null);
    setConfiguration(null);
    setStaff(null);
    setBranding(null);
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
    const preference = await readContextPreference(
      absoluteApi,
      nextIdentity.principal,
    );
    if (generation.current !== requestGeneration) return;
    const resolution = resolveWorkspaceContext({
      apiBaseUrl: absoluteApi,
      principal: nextIdentity.principal,
      memberships: nextIdentity.memberships,
      nowMs: serviceActionTime(),
      preference,
      selected:
        scopeChoice && roleChoice
          ? {
              teamId: scopeChoice.teamId,
              seasonId: scopeChoice.seasonId,
              role: roleChoice,
              playerId:
                roleChoice === "player" ? (scopeChoice.playerId ?? null) : null,
            }
          : null,
      initialRole: props.initialRole,
      teamId: requestedTeamId,
      seasonId: requestedSeasonId,
    });
    const chosen = resolution.selected;
    if (!chosen) {
      setErrors(
        resolution.choices.length
          ? []
          : [
              "This account has no current team, season and role assignment. A received invitation can still be reviewed below.",
            ],
      );
      return;
    }
    // Establish an explicit header-bound selection before any scoped private read.
    // State changes repeat /me; neither a stored preference nor a UI role grants access.
    if (
      scopeChoice?.teamId !== chosen.teamId ||
      scopeChoice?.seasonId !== chosen.seasonId ||
      roleChoice !== chosen.role ||
      (chosen.role === "player" && scopeChoice?.playerId !== chosen.playerId)
    ) {
      setScopeChoice({
        teamId: chosen.teamId,
        seasonId: chosen.seasonId,
        playerId: chosen.playerId,
      });
      setRoleChoice(chosen.role);
      return;
    }
    const resolvedTeamId = chosen.teamId;
    const resolvedSeasonId = chosen.seasonId;
    const scopedPath = (section: string) =>
      `/v1/teams/${encodeURIComponent(resolvedTeamId)}/${section}?seasonId=${encodeURIComponent(resolvedSeasonId)}`;
    const isManager = chosen?.role === "manager",
      isPlayer = chosen?.role === "player",
      isAdministrator = chosen?.role === "administrator";
    if (!initialRoute.current && chosen) {
      setTab(
        isAdministrator
          ? "clubs"
          : chosen.role === "spectator"
            ? "centre"
            : "home",
      );
      initialRoute.current = true;
    }
    const ticket: WorkspaceBinding = {
      generation: requestGeneration,
      apiBaseUrl: absoluteApi,
      accountId: nextIdentity.principal.accountId,
      issuer: nextIdentity.principal.issuer,
      subject: nextIdentity.principal.subject,
      teamId: resolvedTeamId,
      seasonId: resolvedSeasonId,
      role: chosen.role,
      playerId: chosen?.playerId ?? null,
    };
    liveBinding.current = ticket;
    setBinding(ticket);
    void saveContextPreference(
      absoluteApi,
      nextIdentity.principal,
      chosen,
    ).catch(() => {
      if (generation.current === requestGeneration)
        setNotice(
          "Your workspace is open, but this device could not remember the preference. Current service permissions are unchanged.",
        );
    });
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
    const readFault = (
      section: string,
      cause: unknown,
      scopedPrivateList = false,
    ) => {
      if (generation.current !== requestGeneration) return;
      faults.push(`${section}: ${failureText(cause)}`);
      if (
        scopedPrivateList &&
        chosen &&
        cause instanceof ServiceError &&
        [401, 403, 404].includes(cause.status)
      ) {
        // An already attached parallel reply must close when this same authorised
        // ticket receives a known scope denial. Individual photo/entity reads
        // and a new account's invitation setup do not use this list-read gate.
        invalidateRequests();
        setBinding(null);
        setPreparation(null);
        setOwn(null);
        setRecords(null);
        setCommunity(null);
        setMatches(null);
        setSeasons(null);
        setConfiguration(null);
        setStaff(null);
        setBranding(null);
        setErrors([
          ...faults,
          "Private workspace views were closed because the service refused this scope. Refresh service views to verify current access. Retained requests remain unchanged.",
        ]);
      }
    };
    const tasks: Promise<void>[] = isAdministrator
      ? []
      : [
          client
            .request<CommunityDto>(scopedPath("community"))
            .then(async (value) => {
              const attached = await attach(value);
              if (attached) setCommunity(attached);
            })
            .catch((cause) => readFault("Community", cause, true)),
          client
            .request<RecordsDto>(scopedPath("records"))
            .then(async (reply) => {
              if (
                reply.results.visibilityScope !== ticket.role ||
                (!isManager && (reply.editableState || reply.activeMatch))
              )
                throw new Error(
                  "The service returned a report outside the selected role. The view was discarded.",
                );
              const attached = await attach({
                revision: reply.revision,
                results: reply.results,
                participation: reply.participation,
                matches: reply.matches,
                ...(isManager
                  ? {
                      editableState: reply.editableState,
                      activeMatch: reply.activeMatch,
                      contexts: reply.contexts,
                    }
                  : {}),
                playerLabels: reply.playerLabels,
              });
              if (attached) setRecords(attached);
            })
            .catch((cause) => readFault("Reports", cause, true)),
        ];
    if (chosen)
      tasks.push(
        client
          .request<BrandingDto>(scopedPath("branding"))
          .then(async (value) => {
            assertBrandingResponse(value, {
              teamId: resolvedTeamId,
              authoritySeasonId: resolvedSeasonId,
              role: ticket.role,
            });
            const attached = await attach(value);
            if (attached) setBranding(attached);
          })
          .catch((cause) => readFault("Branding", cause, true)),
      );
    if (!isAdministrator)
      tasks.push(
        client
          .request<{ items: ConnectedMatchCentreDto[] }>(scopedPath("matches"))
          .then(async (reply) => {
            if (
              reply.items.some(
                (item) =>
                  item.audience !== ticket.role ||
                  (ticket.role !== "manager" && item.state),
              )
            )
              throw new Error(
                "The service returned match data outside the selected role. The view was discarded.",
              );
            const attached = await attach(reply.items);
            if (attached) setMatches(attached);
          })
          .catch((cause) => readFault("Matches", cause, true)),
      );
    if (isManager || isAdministrator)
      tasks.push(
        client
          .request<ConnectedSeasonOptions>(
            scopedPath("seasons/rollover-options"),
          )
          .then(async (value) => {
            const attached = await attach(value);
            if (attached) setSeasons(attached);
          })
          .catch((cause) => {
            if (generation.current === requestGeneration)
              faults.push(`Seasons: ${failureText(cause)}`);
          }),
      );
    if (isAdministrator)
      tasks.push(
        client
          .request<ConnectedConfigurationDto>(scopedPath("configuration"))
          .then(async (value) => {
            const attached = await attach(value);
            if (attached) setConfiguration(attached);
          })
          .catch((cause) => {
            if (generation.current === requestGeneration)
              faults.push(`Configuration: ${failureText(cause)}`);
          }),
      );
    if (isAdministrator)
      tasks.push(
        client
          .request<ConnectedStaffDto>(scopedPath("managers"))
          .then(async (value) => {
            if (
              value.kind !== "manager-roster" ||
              value.teamId !== ticket.teamId ||
              value.seasonId !== ticket.seasonId ||
              !Number.isSafeInteger(value.revision) ||
              value.revision < 0
            )
              throw new Error(
                "The staff roster differs from this authorised scope. It was discarded.",
              );
            const attached = await attach(value);
            if (attached) setStaff(attached);
          })
          .catch((cause) => {
            if (generation.current === requestGeneration)
              faults.push(`Staff: ${failureText(cause)}`);
          }),
      );
    if (isManager)
      tasks.push(
        client
          .request<PreparationState>(scopedPath("preparation"))
          .then(async (value) => {
            const attached = await attach(value);
            if (attached) setPreparation(attached);
          })
          .catch((cause) => readFault("Preparation", cause, true)),
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
          .catch((cause) => readFault("Own preparation", cause, true)),
      );
    await Promise.all(tasks);
    if (await stillCurrent()) setErrors(faults);
  }, [
    client,
    scopeChoice,
    requestedTeamId,
    requestedSeasonId,
    roleChoice,
    absoluteApi,
    oidcSessionId,
    oidcAccountId,
    oidcIssuer,
    oidcSubject,
    invalidateRequests,
    props.initialRole,
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
      const type = (request.body as { command?: { type?: string } }).command
        ?.type;
      if (
        type &&
        ["invite.created", "invite.accepted", "invite.revoked"].includes(type)
      )
        throw new Error(
          "This legacy invitation request cannot be sent. Review and retire it locally before using server-issued invitations; its original content is retained.",
        );
      const fresh = await client.me<Identity>();
      const verifiedAtMs = serviceActionTime();
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
          !workspaceSessionAllows(session, absoluteApi, serviceActionTime()) ||
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
      {
        const live = liveBinding.current;
        if (
          !binding ||
          !sameWorkspaceBinding(binding, live) ||
          !workspaceBindingIsCurrent(
            binding,
            fresh.principal,
            fresh.memberships,
            serviceActionTime(),
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
            nowMs: serviceActionTime(),
            synthetic: connection.mode === "synthetic",
            session,
          }).bodyJson;
        }
      }
      const response = await authenticatedFetch(
        `${client.baseUrl}${request.path}`,
        {
          method: "POST",
          headers: selectedRoleHeaders(
            {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": request.key,
              "X-Api-Contract-Version": "longball.events/1.1",
            },
            roleChoice,
            binding?.role ?? null,
          ),
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
  const retireLegacyInvitation = async () => {
    if (
      lock.current ||
      !pending?.protected ||
      legacyReviewKey !== pending.key ||
      !binding ||
      !identity
    )
      return;
    const sourceGeneration = generation.current,
      sourceBinding = binding,
      key = pending.key;
    lock.current = true;
    setBusy(true);
    setErrors([]);
    try {
      const fresh = await client.me<Identity>();
      const verifiedAtMs = serviceActionTime();
      const session =
        connection.mode === "oidc" ? await getConnectedSessionSummary() : null;
      if (
        generation.current !== sourceGeneration ||
        !sameWorkspaceBinding(sourceBinding, liveBinding.current) ||
        !workspaceBindingIsCurrent(
          sourceBinding,
          fresh.principal,
          fresh.memberships,
          serviceActionTime(),
        ) ||
        fresh.principal.accountId !== identity.principal.accountId ||
        fresh.principal.issuer !== identity.principal.issuer ||
        fresh.principal.subject !== identity.principal.subject ||
        (connection.mode === "oidc" &&
          (!workspaceSessionAllows(session, absoluteApi, serviceActionTime()) ||
            session?.sessionId !== oidcSessionId ||
            session?.accountId !== identity.principal.accountId ||
            session?.issuer !== identity.principal.issuer ||
            session?.subject !== identity.principal.subject))
      )
        throw new Error(
          "Current access changed. The legacy request remains retained and has not been replayed or retired.",
        );
      const saved = await outboxPort.current?.retireLegacy(key, {
        binding: sourceBinding,
        principal: fresh.principal,
        memberships: fresh.memberships,
        verifiedAtMs,
        nowMs: serviceActionTime(),
        synthetic: connection.mode === "synthetic",
        session,
      });
      if (!saved)
        throw new Error(
          "The local protocol retirement could not be saved. Keep the original request and retry its protected save.",
        );
      setPending(null);
      setLegacyReviewKey(null);
      setNotice(
        "The old invitation request was retired locally and will never be replayed. Its exact content remains in protected history. This is not a server receipt; the previous server status remains unknown. Use current server-issued invitations after refreshing their status.",
      );
    } catch (cause) {
      setErrors([failureText(cause)]);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const mutate = async (
    section: string,
    command:
      | PreparationCommand
      | OwnCommand
      | CommunityCommand
      | RecordsCommand
      | ConnectedRecordsCommand
      | SeasonRolloverCommand
      | ConnectedStaffCommand
      | BrandingCommand,
    label: string,
  ): Promise<boolean> => {
    if (
      lock.current ||
      pending ||
      uploadRetainedRef.current ||
      brandRetainedRef.current ||
      invitationIsRetained()
    )
      return false;
    lock.current = true;
    setBusy(true);
    setErrors([]);
    setNotice(null);
    try {
      if (
        ["invite.created", "invite.accepted", "invite.revoked"].includes(
          command.type,
        )
      )
        throw new Error(
          "Use the current server-issued invitation flow. This older request was not converted or sent.",
        );
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
        !sameWorkspaceBinding(binding, liveBinding.current) ||
        !workspaceBindingIsCurrent(
          binding,
          identity?.principal ?? null,
          identity?.memberships ?? [],
          serviceActionTime(),
        )
      )
        throw new Error(
          "This workspace scope is no longer current. Refresh or sign in again before changing it.",
        );
      const key = "id" in command ? command.id : command.commandId;
      const request = {
        path: path(section),
        key,
        body: { command },
        label,
        protected: protectedOutbox,
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
    if (
      lock.current ||
      pending ||
      uploadRetainedRef.current ||
      brandRetainedRef.current ||
      invitationIsRetained()
    )
      return;
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
  const switchScope = (
    destination: { teamId: string; seasonId: string; playerId?: string | null },
    role: WorkspaceBinding["role"] | null = null,
  ) => {
    guardNavigation(() => {
      setAlbumSelection(null);
      invitationAuthority.current = null;
      invitationHeldRef.current = null;
      setInvitationHeld(null);
      brandScopeRef.current = null;
      brandRetainedRef.current = false;
      setBrandRetained(false);
      albumKeyRef.current = null;
      uploadRetainedRef.current = false;
      setUploadRetained(false);
      invalidateRequests();
      setBinding(null);
      setPreparation(null);
      setOwn(null);
      setRecords(null);
      setCommunity(null);
      setMatches(null);
      setSeasons(null);
      setConfiguration(null);
      setStaff(null);
      setBranding(null);
      setServiceMatchId("");
      setSelectedReportMatchId(null);
      setCommunityInitialSection("photos");
      setRoleChoice(role);
      setScopeChoice(destination);
      setContextPickerOpen(false);
      setTab(
        role === "administrator"
          ? "clubs"
          : role === "spectator"
            ? "centre"
            : "home",
      );
    });
  };
  const exportReport = async (
    request: ConnectedExportRequest,
  ): Promise<string> => {
    const source = liveBinding.current;
    if (!source)
      throw new Error("Open a current authorised workspace before exporting.");
    const parameters = new URLSearchParams({
      kind: request.kind,
      format: request.format,
      expectedProjectionVersion: String(request.expectedProjectionVersion),
      ...(request.matchId ? { matchId: request.matchId } : {}),
    });
    const artifact = await client.request<{
      kind: string;
      fileName: string;
      contentType: string;
      body: string;
      teamId: string;
      seasonId: string;
      audience: string;
      projectionVersion: number;
    }>(`${path("records/export")}&${parameters}`);
    const assertAccess = () =>
      assertReportExportAccess({
        source,
        currentBinding: () => liveBinding.current,
        principal: identity?.principal ?? null,
        memberships: identity?.memberships ?? [],
        nowMs: Date.now,
        session:
          connection.mode === "oidc"
            ? {
                requiredSessionId: oidcSessionId ?? "",
                read: getConnectedSessionSummary,
              }
            : null,
      });
    if (
      artifact.kind !== "records-export" ||
      artifact.teamId !== source.teamId ||
      artifact.seasonId !== source.seasonId ||
      artifact.audience !== source.role ||
      artifact.projectionVersion !== request.expectedProjectionVersion
    )
      throw new Error(
        "The export receipt differs from the requested audience or projection. The file was discarded.",
      );
    return deliverReportExport(artifact, assertAccess);
  };
  const legacyInvitationPending = Boolean(
    pending?.protected &&
      ["invite.created", "invite.accepted"].includes(
        (pending.body as { command?: { type?: string } }).command?.type ?? "",
      ),
  );
  const disabledWithoutInvitation =
    uploadRetained ||
    brandRetained ||
    busy ||
    Boolean(pending) ||
    !storageChecked ||
    (workspaceNeedsProtectedOutbox(
      protectedOutbox,
      expectedBinding,
      identity?.principal ?? null,
      identity?.memberships ?? [],
      membershipTime,
    ) &&
      (!currentOutbox?.state ||
        currentOutbox.busy ||
        currentOutbox.retryPending ||
        currentOutbox.conflict));
  const disabled =
    disabledWithoutInvitation ||
    invitationRetained ||
    Boolean(navigationReview);
  const activeController =
    controllerStatus?.source === controllerSource
      ? controllerStatus.state
      : null;
  useLayoutEffect(() => {
    navigationStateRef.current = {
      memoryPending: Boolean(pending && !pending.protected),
      savedPending: Boolean(
        pending?.protected ||
          currentOutbox?.retryPending ||
          currentOutbox?.conflict,
      ),
      controllerPending: Boolean(activeController?.pendingNetwork),
      controllerUnsent: Boolean(activeController?.unsent),
    };
  }, [
    pending,
    currentOutbox?.retryPending,
    currentOutbox?.conflict,
    activeController,
  ]);
  const brandingPanel =
    branding && brandClient && brandScopeKey ? (
      <BrandLogos
        value={branding}
        client={brandClient}
        scopeKey={brandScopeKey}
        assertAccess={assertBrandAccess}
        disabled={disabled}
        synthetic={connection.mode === "synthetic"}
        onRetainedChange={onBrandRetained}
        onChanged={reload}
        onChange={(command) =>
          mutate(
            `branding/${command.kind}/${command.type === "logo.published" ? "publish" : "remove"}`,
            command,
            command.type === "logo.published"
              ? "Logo publication"
              : "Logo reference removal",
          )
        }
      />
    ) : (
      <Notice>
        Uploaded logos are unavailable until the service returns a current
        authorised branding view.
      </Notice>
    );
  return (
    <View style={s.stack} testID="workspace-session">
      <Card style={{ padding: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {branding && brandClient && brandScopeKey && (
            <AuthenticatedBrandBadge
              client={brandClient}
              reference={branding.effective.logo}
              scopeKey={brandScopeKey}
              assertAccess={assertBrandAccess}
              label={`${branding.team.name} team badge`}
            />
          )}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={typography.section}>
              {selectedContext
                ? preparation
                  ? `${preparation.team.name} ${preparation.team.ageGroup}`
                  : own
                    ? `${own.team.name} ${own.team.ageGroup}`
                    : configuration
                      ? `${configuration.team.name} ${configuration.team.ageGroup}`
                      : (branding?.team.name ?? selectedContext.teamLabel)
                : identity
                  ? "Choose your workspace"
                  : "Checking your account…"}
            </Text>
            {selectedContext && (
              <Text style={typography.muted}>
                {selectedContext.roleLabel} ·{" "}
                {own?.season?.label ??
                  preparation?.seasons.find((item) => item.id === seasonId)
                    ?.label ??
                  configuration?.seasons.find((item) => item.id === seasonId)
                    ?.label ??
                  selectedContext.seasonLabel}
              </Text>
            )}
            <Text
              style={{ fontSize: 10, lineHeight: 14, color: colors.inkMuted }}
            >
              {connection.mode === "synthetic"
                ? "FICTIONAL API REVIEW"
                : "CONNECTED SERVICE"}
            </Text>
          </View>
        </View>
        {selectedContext && contextChoices.length > 1 && (
          <Button
            label="Change space"
            testID="workspace-change-context"
            variant="quiet"
            icon="swap"
            disabled={disabled}
            onPress={() =>
              guardNavigation(() => setContextPickerOpen((value) => !value))
            }
          />
        )}
        {!selectedContext && (
          <View style={s.row}>
            <Button
              label="Account"
              variant="quiet"
              onPress={() =>
                guardNavigation(
                  props.onOpenAccount ?? (() => setTab("account")),
                )
              }
            />
            {props.onLeaveWorkspace && (
              <Button
                label="Return to welcome"
                variant="quiet"
                onPress={() => guardNavigation(props.onLeaveWorkspace!)}
              />
            )}
          </View>
        )}
        {identity &&
          (!selectedContext || contextPickerOpen) &&
          contextChoices.length > 0 && (
            <View style={s.stack} testID="workspace-context-choices">
              <Text style={typography.section}>
                Choose a team, season and role
              </Text>
              <Text style={typography.body}>
                Only current assignments returned by the service are available.
                Your last valid choice can be remembered on this device.
              </Text>
              {contextChoices.map((choice) => (
                <Card key={workspaceContextKey(choice)}>
                  {choice.clubLabel && (
                    <Text style={typography.muted}>{choice.clubLabel}</Text>
                  )}
                  <Text style={typography.section}>{choice.teamLabel}</Text>
                  <Text style={typography.body}>
                    {choice.seasonLabel} · {choice.roleLabel}
                  </Text>
                  <Button
                    label={`Open ${choice.roleLabel} · ${choice.teamLabel} · ${choice.seasonLabel}`}
                    testID={`workspace-context-${choice.role}-${choice.teamId}-${choice.seasonId}-${choice.playerId ?? "none"}`}
                    disabled={disabled}
                    variant={
                      selectedContext &&
                      workspaceContextKey(selectedContext) ===
                        workspaceContextKey(choice)
                        ? "secondary"
                        : "primary"
                    }
                    onPress={() =>
                      switchScope(
                        {
                          teamId: choice.teamId,
                          seasonId: choice.seasonId,
                          playerId: choice.playerId,
                        },
                        choice.role,
                      )
                    }
                  />
                </Card>
              ))}
            </View>
          )}
        {props.invitationDestination && (
          <Button
            label="Review received season invitation"
            variant="secondary"
            disabled={disabled}
            onPress={() => setTab("invitations")}
          />
        )}
        {errors.map((error, index) => (
          <Notice key={`${index}:${error}`} tone="error">
            {error}
          </Notice>
        ))}
        {notice && <Notice>{notice}</Notice>}
        {(activeController?.unsent || activeController?.pendingNetwork) && (
          <Notice tone="warning">
            This match has {activeController.pendingCount} event(s) awaiting
            acknowledgement
            {activeController.pendingNetwork
              ? " and an unresolved service request"
              : ""}
            . Saved records remain in this device journal. Upload or review them
            before changing workspace.
          </Notice>
        )}
        {navigationReview && (
          <Card>
            <Text style={typography.section}>
              Saved requests still need attention
            </Text>
            <Text style={typography.body}>
              Unsynchronised match events or protected requests will remain on
              this device. Leaving does not upload them or confirm that the
              service accepted them. Return to this account and workspace to
              retry.
            </Text>
            <Button
              label="Stay in this workspace"
              onPress={() => setNavigationReview(null)}
            />
            <Button
              label="Continue; keep saved records"
              variant="secondary"
              onPress={() => {
                if (
                  brandRetainedRef.current ||
                  uploadRetainedRef.current ||
                  invitationIsRetained() ||
                  navigationStateRef.current.memoryPending ||
                  lock.current
                ) {
                  setErrors([
                    "A private in-memory request is still retained. Retry or explicitly close it before leaving.",
                  ]);
                  return;
                }
                const proceed = navigationReview;
                setNavigationReview(null);
                proceed();
              }}
            />
          </Card>
        )}
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
            showStorageDetails={tab === "more"}
          />
        ) : tab === "more" || !selectedContext ? (
          <Text style={typography.muted}>
            {storageChecked
              ? "Service changes use memory-only retry on this connection. Closing this workspace clears unsent or unresolved requests; real browser command bodies are not written to browser persistence."
              : "Checking protected request storage before enabling changes…"}
          </Text>
        ) : null}
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
                legacyInvitationPending ||
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
            {legacyInvitationPending && (
              <View style={s.stack}>
                <Notice tone="warning">
                  This older invitation protocol cannot be replayed. The
                  original request remains in protected storage. You may
                  explicitly retire only this unsupported request locally, then
                  issue or reissue a current server-generated invitation. Its
                  past server status remains unknown.
                </Notice>
                <View style={s.row}>
                  <Switch
                    accessibilityLabel="Retire unsupported invitation locally; keep exact history"
                    value={legacyReviewKey === pending.key}
                    disabled={busy}
                    onValueChange={(value) =>
                      setLegacyReviewKey(value ? pending.key : null)
                    }
                  />
                  <Text style={typography.body}>
                    Keep the original history and never replay this old request.
                  </Text>
                </View>
                <Button
                  label="Confirm local retirement of old invitation"
                  testID="workspace-retire-legacy-invitation"
                  variant="secondary"
                  disabled={
                    busy ||
                    legacyReviewKey !== pending.key ||
                    !currentOutbox?.state ||
                    currentOutbox.busy ||
                    currentOutbox.retryPending ||
                    currentOutbox.conflict
                  }
                  onPress={() => {
                    void retireLegacyInvitation();
                  }}
                />
              </View>
            )}
          </>
        )}
        {currentOutbox?.state?.lastSettled?.outcome.kind ===
          "locally_retired" && (
          <Notice>
            Unsupported invitation retired locally. Exact history is retained;
            no server acknowledgement or delivery is claimed.
          </Notice>
        )}
        {(tab === "more" || tab === "account" || !selectedContext) && (
          <Button
            label={busy ? "Contacting service…" : "Refresh service views"}
            variant="secondary"
            disabled={
              busy ||
              Boolean(pending) ||
              uploadRetained ||
              brandRetained ||
              invitationRetained
            }
            onPress={() => {
              void reload();
            }}
          />
        )}
      </Card>
      {expectedBinding && membership && (
        <View testID="workspace-context-ready">
          <WorkspaceNavigation
            role={membership.role}
            active={tab}
            disabled={disabled}
            onSelect={(value) => {
              if (
                !uploadRetainedRef.current &&
                !brandRetainedRef.current &&
                !invitationIsRetained()
              ) {
                if (value === "account" && props.onOpenAccount)
                  guardNavigation(props.onOpenAccount);
                else {
                  if (value === "community")
                    setCommunityInitialSection("photos");
                  setTab(value);
                }
              }
            }}
          />
        </View>
      )}
      {tab === "more" && expectedBinding && (
        <Card>
          <View style={s.stack} testID="workspace-more-panel">
            <Text accessibilityRole="header" style={typography.section}>
              More
            </Text>
            {(manager
              ? [
                  ["centre", "Match centre"],
                  ["community", "Photos and player of the match"],
                  ["settings", "Team settings"],
                  ["seasons", "Seasons"],
                  ["invitations", "Invitations"],
                  ...(props.journal && props.deviceId
                    ? [["controller", "Match recording"]]
                    : []),
                ]
              : [
                  ["team", "My profile"],
                  ["reports", "My reports"],
                  ["invitations", "Invitations"],
                ]
            ).map(([value, label]) => (
              <Button
                key={value}
                label={label}
                testID={`workspace-tab-${value}`}
                variant="secondary"
                disabled={disabled}
                onPress={() => {
                  if (value === "community")
                    setCommunityInitialSection("photos");
                  setTab(value as Tab);
                }}
              />
            ))}
            <Button
              label="Account"
              icon="lock"
              testID="workspace-tab-account"
              variant="secondary"
              onPress={() =>
                guardNavigation(
                  props.onOpenAccount ?? (() => setTab("account")),
                )
              }
            />
            {props.onLeaveWorkspace && (
              <Button
                label="Return to welcome"
                variant="quiet"
                onPress={() => guardNavigation(props.onLeaveWorkspace!)}
              />
            )}
          </View>
        </Card>
      )}
      {tab === "home" && manager && preparation && (
        <ConnectedManagerHome
          state={preparation}
          records={records}
          community={community}
          nowMs={membershipTime}
          onOpenSchedule={() => setTab("schedule")}
          onOpenTeam={() => setTab("team")}
          onOpenReports={() => setTab("reports")}
          onOpenCommunity={() => {
            setCommunityInitialSection("photos");
            setTab("community");
          }}
          onPrepareMatch={() => setTab("schedule")}
          onResumeMatch={
            props.journal && props.deviceId
              ? (matchId: string) => {
                  setServiceMatchId(matchId);
                  setTab("controller");
                }
              : undefined
          }
        />
      )}
      {tab === "home" &&
        membership?.role === "player" &&
        own &&
        teamId &&
        seasonId &&
        membership.playerId && (
          <ConnectedPlayerHome
            key={`${absoluteApi}:${identity?.principal.accountId}:${teamId}:${seasonId}:${membership.playerId}`}
            own={own}
            community={community}
            matches={matches ?? []}
            scope={{ teamId, seasonId, playerId: membership.playerId }}
            nowMs={membershipTime}
            disabled={disabled}
            displayName={own.profile.displayName}
            onOpenSchedule={() => setTab("schedule")}
            onOpenProfile={() => setTab("team")}
            onOpenGame={() => setTab("centre")}
            onOpenVote={() => {
              setCommunityInitialSection("awards");
              setTab("community");
            }}
            onOpenAlbum={openAlbum}
            onReply={(event, response) => {
              void mutate(
                "preparation/own",
                {
                  id: randomUUID(),
                  expectedRevision: own.revision,
                  ...(event.kind === "match"
                    ? {
                        type: "own.fixture_response_recorded",
                        fixtureId: event.id,
                        response,
                      }
                    : {
                        type: "own.training_response_recorded",
                        trainingId: event.id,
                        response,
                      }),
                },
                "Own availability reply",
              );
            }}
            renderPhoto={(photo) =>
              communityActor ? (
                <RemotePhoto
                  key={`${albumKey}:${photo.id}:${photo.version}`}
                  client={
                    new MediaUploadClient(
                      connection.baseUrl || "/",
                      communityActor,
                      authenticatedFetch,
                    )
                  }
                  photoId={photo.id}
                  revision={photo.version}
                  mode="gallery"
                  variant="thumbnail"
                />
              ) : null
            }
          />
        )}
      {tab === "home" && membership?.role === "player" && !own && (
        <Notice>
          Your current player home is unavailable. Refresh after the service
          confirms your own team and season assignment.
        </Notice>
      )}
      {tab === "clubs" && administrator && configuration && (
        <Card>
          <Text style={typography.section}>Clubs</Text>
          <Text style={typography.body}>{configuration.club.name}</Text>
          <Text style={typography.muted}>
            This is the club attached to your current service assignment.
            Private team records require a separate manager role.
          </Text>
          <Button
            label="Edit club and team configuration"
            disabled={disabled}
            onPress={() => setTab("settings")}
          />
          <Button
            label="View assigned teams"
            variant="secondary"
            disabled={disabled}
            onPress={() => setTab("team")}
          />
        </Card>
      )}
      {tab === "people" &&
        administrator &&
        (staff ? (
          <ConnectedStaffPanel
            value={staff}
            disabled={disabled}
            onChange={(command) =>
              mutate(
                command.type === "manager.revoked"
                  ? "managers/revoke"
                  : "managers",
                command,
                "Staff assignment",
              )
            }
          />
        ) : (
          <Notice>
            People are unavailable until the service confirms your administrator
            assignment.
          </Notice>
        ))}
      {tab === "account" && (
        <Card>
          <Text style={typography.section}>Account</Text>
          <Text style={typography.body}>
            {selectedContext?.roleLabel ?? "No selected workspace"}
          </Text>
          <Text style={typography.muted}>
            {identity?.principal.accountId ?? "Checking account"}
          </Text>
          {props.onOpenAccount && (
            <Button
              label="Open account and security"
              onPress={() => guardNavigation(props.onOpenAccount!)}
            />
          )}
          {props.onLeaveWorkspace && (
            <Button
              label="Return to welcome"
              variant="secondary"
              onPress={() => guardNavigation(props.onLeaveWorkspace!)}
            />
          )}
        </Card>
      )}
      {tab === "centre" &&
        membership &&
        membership.role !== "administrator" &&
        (matches ? (
          <ConnectedMatchCentre
            matches={matches}
            reportView={records}
            scope={
              teamId && seasonId
                ? { teamId, seasonId, playerId: membership.playerId ?? null }
                : undefined
            }
            observedAtMs={membershipTime}
            audience={membership.role as ConnectedMatchCentreDto["audience"]}
            busy={disabled}
            onRefresh={() => {
              void reload();
            }}
            onReports={() => setTab("reports")}
            onPhotos={() => {
              setCommunityInitialSection("photos");
              setTab("community");
            }}
            onOpenReport={(matchId) => {
              setSelectedReportMatchId(matchId);
              setTab("reports");
            }}
            onOpenAlbum={openAlbum}
          />
        ) : (
          <Notice>
            Match updates are unavailable in this current authorised context.
          </Notice>
        ))}
      {(tab === "schedule" || tab === "team" || tab === "settings") &&
        (administrator && configuration ? (
          <ConnectedClubConfiguration
            key={`${configuration.team.id}:${configuration.revision}`}
            value={configuration}
            disabled={disabled}
            staff={staff}
            brandingPanel={brandingPanel}
            onStaffChange={(command) =>
              mutate(
                command.type === "manager.revoked"
                  ? "managers/revoke"
                  : "managers",
                command,
                "Staff assignment",
              )
            }
            onChange={(command) =>
              mutate("configuration", command, "Configuration change")
            }
          />
        ) : manager && preparation ? (
          <PreparationScreens
            storage="service"
            brandingPanel={brandingPanel}
            state={preparation}
            view={tab}
            onChange={(command) =>
              mutate("preparation", command, "Preparation change")
            }
            busy={disabled}
            onPrepareRollover={() => setTab("seasons")}
            onPrepareChildActivation={
              props.onPrepareChildActivation && teamId && seasonId
                ? (playerId) =>
                    props.onPrepareChildActivation?.({
                      teamId,
                      seasonId,
                      playerId,
                    })
                : undefined
            }
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
            view={tab === "team" ? "profile" : "schedule"}
            nowMs={membershipTime}
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
      {tab === "seasons" &&
        (seasonOptions && (manager || administrator) ? (
          <ConnectedSeasonRollover
            key={`${seasonOptions.sourceSeasonId}:${seasonOptions.revision}`}
            options={seasonOptions}
            disabled={disabled}
            onSave={async (command) => {
              const saved = await mutate("seasons", command, "New season");
              if (saved && teamId && identity) {
                const id = identity.principal.accountId;
                const nextRole = command.managerAccountIds.includes(id)
                  ? "manager"
                  : command.administratorAccountIds.includes(id)
                    ? "administrator"
                    : command.playerAssignments.some(
                          (item) => item.accountId === id,
                        )
                      ? "player"
                      : null;
                if (nextRole)
                  switchScope(
                    { teamId, seasonId: command.idForSeason },
                    nextRole,
                  );
                else
                  setNotice(
                    `New season ${seasonOptions.nextSeason.label} was saved. Your account was not assigned a role there; source-season access remains separate.`,
                  );
              }
              return saved;
            }}
          />
        ) : (
          <Notice>
            Season assignment options are unavailable in this context. The
            service checks administrator authority and recent stronger
            authentication.
          </Notice>
        ))}
      {tab === "reports" &&
        (membership && membership.role !== "administrator" && records ? (
          <ConnectedRecordsScreens
            value={records}
            initialMatchId={selectedReportMatchId ?? undefined}
            audience={membership.role as "manager" | "player" | "spectator"}
            teamLabel={
              preparation
                ? `${preparation.team.name} ${preparation.team.ageGroup}`
                : own
                  ? `${own.team.name} ${own.team.ageGroup}`
                  : (community?.teamLabel ?? "Team")
            }
            disabled={disabled}
            onChange={(command) => mutate("records", command, "Result")}
            onExport={exportReport}
            onOpenAlbum={openAlbum}
            onOpenController={
              manager && props.journal && props.deviceId
                ? (matchId) => {
                    setServiceMatchId(matchId);
                    setTab("controller");
                  }
                : undefined
            }
          />
        ) : (
          <Notice>
            Reports are unavailable for the current service account.
          </Notice>
        ))}
      {tab === "community" && (
        <>
          {community && communityActor && albumScope ? (
            <ConnectedCommunity
              key={`${communityActor.accountId}:${communityActor.teamId}:${communityActor.seasonId}:${communityActor.role}`}
              value={community}
              initialSection={communityInitialSection}
              actor={communityActor}
              albumScope={albumScope}
              albumSelection={albumSelection}
              onSelectAlbum={setAlbumSelection}
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
            albumScope && (
              <MediaUpload
                actor={communityActor}
                apiBaseUrl={connection.baseUrl || "/"}
                synthetic={connection.mode === "synthetic"}
                allowLibraryPicker={props.allowSynthetic === false}
                albumScope={albumScope}
                matches={community.matches}
                selection={selectedAlbum ? albumSelection : null}
                allowed={community.allowed}
                onRetainedChange={onUploadRetained}
                onChanged={reload}
              />
            )}
        </>
      )}
      {(tab === "community" || tab === "invitations") &&
        identity &&
        invitationScopeKey && (
          <ScopedWorkspaceInvitations
            baseUrl={connection.baseUrl || "/"}
            authenticatedFetch={authenticatedFetch}
            scopeKey={invitationScopeKey}
            active={identity.principal.status === "active"}
            assertCurrent={assertInvitationCurrent}
            disabled={disabledWithoutInvitation}
            teamId={teamId ?? null}
            seasonId={seasonId ?? null}
            canIssue={
              invitationRole === "manager" || invitationRole === "player"
            }
            invitationDestination={props.invitationDestination}
            onRetainedChange={onInvitationRetained}
            onChanged={async (acceptedScope) => {
              await reload();
              if (acceptedScope) switchScope(acceptedScope, "spectator");
            }}
          />
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
              initialConnection={
                props.initialConnection ? connection : undefined
              }
              onControllerState={handleControllerState}
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
  view = "schedule",
  nowMs,
  disabled,
  onChange,
}: {
  value: OwnPreparationDto;
  view?: "schedule" | "profile";
  nowMs: number;
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
  const [schedulePeriod, setSchedulePeriod] = useState<"upcoming" | "past">(
    "upcoming",
  );
  const dayParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const today = `${dayParts.find((part) => part.type === "year")!.value}-${dayParts.find((part) => part.type === "month")!.value}-${dayParts.find((part) => part.type === "day")!.value}`;
  const events = [
    ...value.fixtures.map((item) => ({ ...item, kind: "match" as const })),
    ...value.training.map((item) => ({ ...item, kind: "training" as const })),
  ];
  const groups = groupPreparationEvents(events, {
    period: schedulePeriod,
    today,
    date: (event) => (event.kind === "match" ? event.playedDate : event.date),
    time: (event) => (event.kind === "match" ? event.kickoff : event.time),
  });
  const fixtureCard = (fixture: OwnPreparationDto["fixtures"][number]) => (
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
  );
  const trainingCard = (training: OwnPreparationDto["training"][number]) => (
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
  );
  return (
    <View style={s.stack} testID="workspace-own-preparation">
      {view === "profile" && (
        <Card>
          <Text style={typography.section}>
            {value.profile.displayName} · my preferences
          </Text>
          <Text style={typography.muted}>
            {value.team.name} {value.team.ageGroup} · {value.season.label}
          </Text>
          <Text style={typography.body}>
            Shirt {value.profile.shirtNumber ?? "not recorded"} · preferred
            foot: {value.profile.foot.replaceAll("_", " ")} · manager-approved
            positions:{" "}
            {value.profile.eligiblePositions.join(", ") || "not recorded"}.
          </Text>
          <Text style={typography.body}>
            Choose three distinct positions in order. Goalkeeper eligibility is
            approved separately by a manager. Changes apply to future
            preparation; existing match snapshots retain their original profile
            and lineup.
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
      )}
      {view === "schedule" && (
        <>
          <Text accessibilityRole="header" style={typography.section}>
            My schedule
          </Text>
          <Notice>
            Your reply, the manager’s selection and actual attendance are
            separate records. Your account can change its own reply; attendance
            is recorded by the manager.
          </Notice>
          <View style={s.row}>
            {(["upcoming", "past"] as const).map((period) => (
              <Button
                key={period}
                label={period === "upcoming" ? "Upcoming" : "Past"}
                testID={`own-schedule-${period}`}
                variant={schedulePeriod === period ? "primary" : "secondary"}
                disabled={disabled}
                onPress={() => setSchedulePeriod(period)}
              />
            ))}
          </View>
          {!groups.length && (
            <Notice>
              No {schedulePeriod} matches or training are recorded.
            </Notice>
          )}
          {groups.map((group) => (
            <View
              key={group.date ?? "undated"}
              style={s.stack}
              testID={`own-schedule-group-${group.date ?? "undated"}`}
            >
              <Text accessibilityRole="header" style={typography.section}>
                {group.date ?? "Date to confirm"}
              </Text>
              {group.date === null && (
                <Text style={typography.muted}>
                  These events have no valid recorded date. Confirm the schedule
                  before relying on their order.
                </Text>
              )}
              {group.events.map((event) => (
                <View
                  key={`${event.kind}:${event.id}`}
                  testID={`own-schedule-event-${event.kind}-${event.id}`}
                >
                  {event.kind === "match"
                    ? fixtureCard(event)
                    : trainingCard(event)}
                </View>
              ))}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

function ConnectedCommunity({
  value,
  actor,
  media,
  albumScope,
  albumSelection,
  onSelectAlbum,
  disabled,
  onChange,
  initialSection = "photos",
}: {
  value: CommunityDto;
  actor: CommunityActor;
  media: MediaUploadClient;
  albumScope: AlbumScope;
  albumSelection: AlbumSelection | null;
  onSelectAlbum: (selection: AlbumSelection | null) => void;
  disabled: boolean;
  onChange: (command: CommunityPayload) => Promise<boolean>;
  initialSection?: "photos" | "awards";
}) {
  const [showPreferences, setShowPreferences] = useState(false);
  const [cutoff, setCutoff] = useState("");
  const [closingAward, setClosingAward] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");
  const scopeKey = albumScopeKey(albumScope);
  const currentScope = useRef(scopeKey);
  const mounted = useRef(true);
  const actionLock = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const [voteDrafts, setVoteDrafts] = useState<
    Record<string, { candidateId: string; baseChoice: string | null }>
  >({});
  const [editingVotes, setEditingVotes] = useState<Record<string, boolean>>({});
  const [voteFeedback, setVoteFeedback] = useState<
    Record<string, "sending" | "failed" | undefined>
  >({});
  const [reportTarget, setReportTarget] = useState<{
    scopeKey: string;
    photoId: string;
    revision: number;
    type: "photo" | "uploader";
    id: string;
    label: string;
  } | null>(null);
  const [concernCategory, setConcernCategory] = useState<
    "privacy" | "inappropriate" | "other"
  >("privacy");
  const [concernExplanation, setConcernExplanation] = useState("");
  const [concernFailed, setConcernFailed] = useState(false);
  const [hideTarget, setHideTarget] = useState<{
    scopeKey: string;
    photoId: string;
    revision: number;
    uploaderAccountId: string;
    label: string;
  } | null>(null);
  useLayoutEffect(() => {
    currentScope.current = scopeKey;
  }, [scopeKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = (ticket: string) =>
    mounted.current && currentScope.current === ticket;
  const controlsDisabled = disabled || actionPending;
  const activeReport =
    reportTarget?.scopeKey === scopeKey &&
    value.allowed &&
    value.gallery.some(
      (photo) =>
        photo.id === reportTarget.photoId &&
        photo.version === reportTarget.revision &&
        (reportTarget.type === "photo" ? photo.id : photo.uploaderAccountId) ===
          reportTarget.id,
    )
      ? reportTarget
      : null;
  const activeHide =
    hideTarget?.scopeKey === scopeKey &&
    value.allowed &&
    hideTarget.uploaderAccountId !== actor.accountId &&
    value.gallery.some(
      (photo) =>
        photo.id === hideTarget.photoId &&
        photo.version === hideTarget.revision &&
        photo.uploaderAccountId === hideTarget.uploaderAccountId,
    )
      ? hideTarget
      : null;
  const send = async (command: CommunityPayload): Promise<boolean> => {
    if (disabled || actionLock.current || !current(scopeKey)) return false;
    const ticket = scopeKey;
    actionLock.current = true;
    setActionPending(true);
    try {
      return (await onChange(command)) && current(ticket);
    } catch {
      return false;
    } finally {
      actionLock.current = false;
      if (current(ticket)) setActionPending(false);
    }
  };

  const [viewed, setViewed] = useState<string[]>([]);
  const [photoAcknowledged, setPhotoAcknowledged] = useState(false);
  const [quietStart, setQuietStart] = useState(
    value.preferences.quietStart ?? "",
  );
  const [quietEnd, setQuietEnd] = useState(value.preferences.quietEnd ?? "");
  const validQuietHours =
    (!quietStart && !quietEnd) ||
    (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(quietStart) &&
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(quietEnd) &&
      quietStart !== quietEnd);
  const albumsSection = (
    <ConnectedAlbums
      key="community-albums"
      scope={albumScope}
      allowed={value.allowed}
      matches={value.matches}
      photos={value.gallery}
      selection={albumSelection}
      onSelect={onSelectAlbum}
      disabled={disabled}
      renderThumbnail={(photo) => (
        <RemotePhoto
          key={`${photo.id}:${photo.version}:thumbnail`}
          client={media}
          photoId={photo.id}
          revision={photo.version}
          mode="gallery"
          variant="thumbnail"
        />
      )}
      renderPhoto={(photo) => (
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
            label="Report photo"
            testID={`community-report-photo-${photo.id}`}
            variant="secondary"
            disabled={controlsDisabled}
            onPress={() => {
              setHideTarget(null);
              setConcernFailed(false);
              setConcernCategory("privacy");
              setConcernExplanation("");
              setReportTarget({
                scopeKey,
                photoId: photo.id,
                revision: photo.version,
                type: "photo",
                id: photo.id,
                label: photo.caption || "Published photo",
              });
            }}
          />
          <Button
            label="Report uploader"
            testID={`community-report-uploader-${photo.id}`}
            variant="secondary"
            disabled={controlsDisabled}
            onPress={() => {
              setHideTarget(null);
              setConcernFailed(false);
              setConcernCategory("privacy");
              setConcernExplanation("");
              setReportTarget({
                scopeKey,
                photoId: photo.id,
                revision: photo.version,
                type: "uploader",
                id: photo.uploaderAccountId,
                label: photo.uploaderLabel,
              });
            }}
          />
          {photo.uploaderAccountId !== actor.accountId && (
            <Button
              label="Hide this uploader"
              testID={`community-hide-uploader-${photo.id}`}
              variant="quiet"
              disabled={controlsDisabled}
              onPress={() => {
                setReportTarget(null);
                setHideTarget({
                  scopeKey,
                  photoId: photo.id,
                  revision: photo.version,
                  uploaderAccountId: photo.uploaderAccountId,
                  label: photo.uploaderLabel,
                });
              }}
            />
          )}
          {activeReport?.photoId === photo.id && (
            <View
              style={s.divider}
              testID={`community-concern-form-${photo.id}`}
            >
              <Text style={typography.section}>
                Report {activeReport.type === "photo" ? "photo" : "uploader"}
              </Text>
              <Text style={typography.body}>{activeReport.label}</Text>
              <Text style={typography.muted}>
                Choose a concern category. Avoid unnecessary personal details.
                Reporting and hiding are separate actions; your identity is not
                shown to the uploader.
              </Text>
              <View style={s.row}>
                {(["privacy", "inappropriate", "other"] as const).map(
                  (category) => (
                    <Button
                      key={category}
                      label={`${category === "privacy" ? "Privacy" : category === "inappropriate" ? "Inappropriate content" : "Other"}${concernCategory === category ? " · selected" : ""}`}
                      testID={`community-concern-category-${category}`}
                      variant={
                        concernCategory === category ? "primary" : "secondary"
                      }
                      disabled={controlsDisabled}
                      onPress={() => setConcernCategory(category)}
                    />
                  ),
                )}
              </View>
              <TextInput
                accessibilityLabel="Concern explanation"
                value={concernExplanation}
                onChangeText={setConcernExplanation}
                maxLength={500}
                multiline
                placeholder="Optional explanation · up to 500 characters"
                style={s.input}
                editable={!controlsDisabled}
              />
              <Button
                label="Submit report"
                testID="community-submit-concern"
                disabled={controlsDisabled || concernExplanation.length > 500}
                onPress={() => {
                  const target = activeReport,
                    ticket = scopeKey;
                  if (!target) return;
                  setConcernFailed(false);
                  void send({
                    type: "concern.submitted",
                    concernId: randomUUID(),
                    targetType: target.type,
                    targetId: target.id,
                    category: concernCategory,
                    explanation: concernExplanation.trim(),
                  }).then((saved) => {
                    if (!current(ticket)) return;
                    if (saved) {
                      setReportTarget(null);
                      setConcernExplanation("");
                    } else setConcernFailed(true);
                  });
                }}
              />
              {concernFailed && (
                <Notice tone="warning">
                  The report has not been confirmed. Review the service message
                  and any retained request before submitting again.
                </Notice>
              )}
              <Button
                label="Cancel report"
                testID="community-cancel-concern"
                variant="quiet"
                disabled={controlsDisabled}
                onPress={() => {
                  setReportTarget(null);
                  setConcernExplanation("");
                  setConcernFailed(false);
                }}
              />
            </View>
          )}
          {activeHide?.photoId === photo.id && (
            <View style={s.divider} testID="community-hide-confirmation">
              <Text style={typography.section}>
                Hide {activeHide.label} from your gallery?
              </Text>
              <Notice>
                Their photos will be hidden from this account’s gallery.
                Official match records and authorised moderation stay available.
                This does not remove photos for other people or block the
                uploader’s account.
              </Notice>
              <Button
                label="Confirm gallery-only hide"
                testID="community-confirm-hide-uploader"
                disabled={controlsDisabled}
                onPress={() => {
                  const target = activeHide,
                    ticket = scopeKey;
                  if (!target) return;
                  void send({
                    type: "uploader.hidden",
                    uploaderAccountId: target.uploaderAccountId,
                    hidden: true,
                  }).then((saved) => {
                    if (saved && current(ticket)) setHideTarget(null);
                  });
                }}
              />
              <Button
                label="Cancel hide"
                testID="community-cancel-hide-uploader"
                variant="quiet"
                disabled={controlsDisabled}
                onPress={() => setHideTarget(null)}
              />
            </View>
          )}
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
      )}
    />
  );
  const awardsSection = (
    <View key="community-awards" style={s.stack} testID="community-awards">
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
              {actor.role === "player" && (
                <View style={s.stack} testID={`connected-ballot-${match.id}`}>
                  {match.ownChoice && (
                    <View style={s.stack}>
                      <Text style={typography.label}>
                        Current choice:{" "}
                        {match.candidates.find(
                          (candidate) => candidate.id === match.ownChoice,
                        )?.label ?? "Your recorded teammate choice"}
                      </Text>
                      <Text style={typography.muted}>
                        Confirmed by the service. This account has one recorded
                        private choice.
                      </Text>
                    </View>
                  )}
                  {match.mayVote ? (
                    !match.ownChoice || editingVotes[match.id] ? (
                      <>
                        <Text style={typography.label}>
                          Choose one teammate who played
                        </Text>
                        <Text style={typography.muted}>
                          Selecting a name is a draft. Your vote counts only
                          after the service confirms it.
                        </Text>
                        {match.candidates.map((candidate) => {
                          const draft = voteDrafts[match.id];
                          const selected =
                            draft?.baseChoice === match.ownChoice &&
                            draft.candidateId === candidate.id;
                          return (
                            <Button
                              key={candidate.id}
                              testID={`community-vote-option-${match.id}-${candidate.id}`}
                              label={`${candidate.label}${selected ? " · selected" : ""}`}
                              variant={selected ? "primary" : "secondary"}
                              disabled={controlsDisabled}
                              onPress={() => {
                                setVoteDrafts((previous) => ({
                                  ...previous,
                                  [match.id]: {
                                    candidateId: candidate.id,
                                    baseChoice: match.ownChoice,
                                  },
                                }));
                                setVoteFeedback((previous) => ({
                                  ...previous,
                                  [match.id]: undefined,
                                }));
                              }}
                            />
                          );
                        })}
                        <Button
                          label={
                            match.ownChoice
                              ? "Confirm changed vote"
                              : "Confirm vote"
                          }
                          testID={`community-confirm-vote-${match.id}`}
                          disabled={
                            controlsDisabled ||
                            voteDrafts[match.id]?.baseChoice !==
                              match.ownChoice ||
                            !match.candidates.some(
                              (candidate) =>
                                candidate.id ===
                                voteDrafts[match.id]?.candidateId,
                            ) ||
                            voteDrafts[match.id]?.candidateId ===
                              match.ownChoice
                          }
                          onPress={() => {
                            const draft = voteDrafts[match.id],
                              ticket = scopeKey;
                            if (
                              !draft ||
                              draft.baseChoice !== match.ownChoice ||
                              !match.mayVote ||
                              !match.candidates.some(
                                (candidate) =>
                                  candidate.id === draft.candidateId,
                              )
                            )
                              return;
                            setVoteFeedback((previous) => ({
                              ...previous,
                              [match.id]: "sending",
                            }));
                            void send({
                              type: "ballot.cast",
                              matchId: match.id,
                              candidatePlayerId: draft.candidateId,
                            }).then((saved) => {
                              if (!current(ticket)) return;
                              setVoteFeedback((previous) => ({
                                ...previous,
                                [match.id]: saved ? undefined : "failed",
                              }));
                              if (saved)
                                setEditingVotes((previous) => ({
                                  ...previous,
                                  [match.id]: false,
                                }));
                            });
                          }}
                        />
                        {match.ownChoice && (
                          <Button
                            label="Keep current vote"
                            variant="quiet"
                            disabled={controlsDisabled}
                            onPress={() => {
                              setEditingVotes((previous) => ({
                                ...previous,
                                [match.id]: false,
                              }));
                              setVoteDrafts((previous) => ({
                                ...previous,
                                [match.id]: {
                                  candidateId: match.ownChoice!,
                                  baseChoice: match.ownChoice,
                                },
                              }));
                            }}
                          />
                        )}
                      </>
                    ) : (
                      <Button
                        label="Change vote"
                        testID={`community-change-vote-${match.id}`}
                        variant="secondary"
                        disabled={controlsDisabled}
                        onPress={() => {
                          setEditingVotes((previous) => ({
                            ...previous,
                            [match.id]: true,
                          }));
                          setVoteDrafts((previous) => ({
                            ...previous,
                            [match.id]: {
                              candidateId: match.ownChoice!,
                              baseChoice: match.ownChoice,
                            },
                          }));
                        }}
                      />
                    )
                  ) : (
                    <Text style={typography.muted}>
                      {match.award
                        ? "Voting is closed. Any final award is shown above."
                        : "Voting is unavailable for this account or match window."}
                    </Text>
                  )}
                  {voteFeedback[match.id] === "sending" && (
                    <Text
                      accessibilityLiveRegion="polite"
                      testID={`community-vote-status-${match.id}`}
                      style={typography.muted}
                    >
                      Sending vote for service confirmation…
                    </Text>
                  )}
                  {voteFeedback[match.id] === "failed" && (
                    <Notice tone="warning">
                      Your vote has not been confirmed. Review the service
                      message and retry any retained original request above
                      before starting another.
                    </Notice>
                  )}
                </View>
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
                    {closingAward === match.id ? (
                      <>
                        <Notice tone="warning">
                          Closing seals the latest valid private choices and
                          records a winner, joint winners or no valid votes. It
                          cannot reopen voting or move the original finalisation
                          deadline.
                        </Notice>
                        <Button
                          label="Confirm service ballot close and finalise"
                          disabled={disabled}
                          onPress={() => {
                            void onChange({
                              type: "award.finalised",
                              matchId: match.id,
                            }).then((saved) => {
                              if (saved) setClosingAward(null);
                            });
                          }}
                        />
                        <Button
                          label="Keep service ballot open"
                          variant="quiet"
                          disabled={disabled}
                          onPress={() => setClosingAward(null)}
                        />
                      </>
                    ) : (
                      <Button
                        label="Review closing this service ballot"
                        variant="secondary"
                        disabled={disabled}
                        onPress={() => setClosingAward(match.id)}
                      />
                    )}
                  </>
                )}
            </>
          )}
        </Card>
      ))}
    </View>
  );
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
        {value.matches.some((match) => !match.sharingAllowed) && (
          <Notice tone="warning">
            The service withholds match context, scores and derived awards where
            competition sharing is unapproved. Accepted match finish evidence
            and an approved policy are required for connected award
            registration.
          </Notice>
        )}
      </Card>
      {initialSection === "awards"
        ? [awardsSection, albumsSection]
        : [albumsSection, awardsSection]}
      <Button
        label={
          showPreferences
            ? "Hide notification preferences"
            : "Show notification preferences"
        }
        testID="community-toggle-preferences"
        variant="quiet"
        disabled={controlsDisabled}
        onPress={() => setShowPreferences((visible) => !visible)}
      />
      {showPreferences && (
        <Card>
          <Text style={typography.section}>My notification preferences</Text>
          <Text style={typography.body}>
            These choices control eligible service notifications. A saved
            preference does not mean a message has been delivered; device
            permission and an operational delivery provider are also required.
          </Text>
          {(["schedule", "match", "awards", "photos"] as const).map(
            (category) => (
              <View
                key={category}
                style={[s.row, { justifyContent: "space-between" }]}
              >
                <Text style={typography.label}>{category} updates</Text>
                <Switch
                  accessibilityLabel={`Service ${category} updates`}
                  value={value.preferences[category]}
                  disabled={disabled}
                  onValueChange={(enabled) => {
                    void onChange({
                      type: "preferences.changed",
                      preferences: {
                        ...value.preferences,
                        [category]: enabled,
                      },
                    });
                  }}
                />
              </View>
            ),
          )}
          <Text style={typography.label}>Quiet hours · Europe/London</Text>
          <TextInput
            accessibilityLabel="Service quiet hours start Europe/London"
            placeholder="Start HH:MM"
            value={quietStart}
            onChangeText={setQuietStart}
            style={s.input}
            autoCapitalize="none"
          />
          <TextInput
            accessibilityLabel="Service quiet hours end Europe/London"
            placeholder="End HH:MM"
            value={quietEnd}
            onChangeText={setQuietEnd}
            style={s.input}
            autoCapitalize="none"
          />
          {!validQuietHours && (
            <Notice tone="warning">
              Choose two distinct HH:MM times or clear both fields. Use the
              category switches to pause notifications all day.
            </Notice>
          )}
          <Button
            label="Save service quiet hours"
            variant="secondary"
            disabled={disabled || !validQuietHours}
            onPress={() => {
              void onChange({
                type: "preferences.changed",
                preferences: {
                  ...value.preferences,
                  quietStart: quietStart || null,
                  quietEnd: quietEnd || null,
                },
              });
            }}
          />
        </Card>
      )}
      {actor.role !== "spectator" && value.grants.length > 0 && (
        <Card>
          <Text style={typography.section}>
            Accepted spectator season grants
          </Text>
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
        <Text style={typography.section}>My concerns</Text>
        <Text style={typography.muted}>
          References and status for reports made by this account. Reporter
          identity is not disclosed to uploaders.
        </Text>
        <View style={s.stack} testID="community-own-concerns">
          {value.ownConcerns.length ? (
            value.ownConcerns.map((concern) => (
              <View
                key={concern.id}
                style={s.divider}
                testID={`community-own-concern-${concern.id}`}
              >
                <Pill tone="info">{concern.status.replaceAll("_", " ")}</Pill>
                <Text style={typography.label}>
                  {concern.targetType === "photo"
                    ? "Photo concern"
                    : "Uploader concern"}
                </Text>
                <Text selectable style={typography.muted}>
                  Reference {concern.id}
                </Text>
                <Text style={typography.muted}>
                  Submitted {dateTime(concern.createdAtMs)}
                </Text>
              </View>
            ))
          ) : (
            <Text style={typography.body}>
              No concerns submitted by this account.
            </Text>
          )}
        </View>
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
  variant = "display",
  onViewed,
}: {
  client: MediaUploadClient;
  photoId: string;
  revision: number;
  mode: "own" | "gallery" | "review";
  variant?: "thumbnail" | "display";
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
            : variant === "thumbnail"
              ? "View authorised thumbnail"
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
            .image(photoId, revision, variant, mode)
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
              height: variant === "thumbnail" ? 120 : 240,
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
