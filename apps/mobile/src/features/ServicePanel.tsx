import { formatUkDateTime } from '@longball/application/uk-display';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { applyMutationResponse, assertConnectedDocument, canCaptureConnectedEvents, connectedClock, createConnectedDocument, LongBallServiceClient, mergeDownload, prepareServiceRequest, queueConnectedCommand, retainClockMapping, selectAcceptedBranch, ServiceError, settleDefiniteRefusal, type ConnectedCommand, type ConnectedMatchDocument, type DurableRequest, type HttpFetch } from '@longball/application/sync';
import { assertControllerDownloadScope, controllerAuthorityWasDenied, controllerCacheDocumentId, controllerCachePlatformAllowed, controllerCacheScope, controllerSessionAllowsCache, type ControllerCacheScope, type ControllerIdentity } from '@longball/application/connected-scope';
import { assertSavedMatchRoster, queueNativeLiveCommand } from '@longball/application/connected-live-editor';
import { establishContinuousClockMapping } from '@longball/application/clock-exchange';
import { assertStaticReviewApiAddress } from '@longball/application/static-review';
import { ENGINE_VERSION, type Allocation, type ClockSample, type MatchState } from '@longball/domain';
import { connectedFetch, getConnectedSessionSummary } from '../platform/auth/client';
import { readClock } from '../platform/clock';
import { randomUUID } from '../platform/id';
import type { Journal } from '../platform/types';
import { useDocument } from '../useDocument';
import { Button, Card, Notice, Pill } from '../ui/Button';
import { colors, typography } from '../ui/tokens';
import { acceptedMatchView } from '@longball/application/accepted-match-view';
import { AcceptedMatchView } from './AcceptedMatchView';
import { ConnectedLiveEditor } from './ConnectedLiveEditor';
import { PlannerPanel, usePlannerModel, type PlannerPersistence, type PlannerPolicyPort } from './PlannerPanel';
import { HistoryReviewPanel } from './HistoryReviewPanel';
import { useWorkspaceLayout } from '../ui/WorkspaceLayout';

export interface ConnectedControllerState {
  scope: 'connected-rehearsal'; matchId: string; deviceId: string; epoch: number | null;
  lifecycle: 'active' | 'closed';
  hasControl: boolean; reconciliationRequired: boolean;
  /** Local events or a retained save/conflict still need attention. */
  unsent: boolean;
  /** An exact HTTP request remains unresolved, including after network activity stops. */
  pendingNetwork: boolean;
  pendingCount: number;
}
export interface ServicePanelProps {
  journal: Journal | null;
  deviceId: string | null;
  match: MatchState | null;
  allowSynthetic?: boolean;
  teamId?: string;
  seasonId?: string;
  matchId?: string;
  initialConnection?: { baseUrl: string; mode: 'synthetic' | 'oidc'; account: string };
  fillScreen?: boolean;
  onControllerState?: (state: ConnectedControllerState) => void;
}
interface ConnectionConfig { baseUrl: string; mode: 'synthetic' | 'oidc'; syntheticAccount: string; wireDeviceId: string; scope: ControllerCacheScope; configurationKey: string }
function clockSample(): ClockSample { const sample = readClock(); return { monotonicMs: sample.monotonicMs, sessionId: sample.continuityId, wallTimeMs: Date.now() }; }
function formatMs(ms: number): string { const seconds = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }

/** Canonical HTTP rehearsal. It never uploads the older M0 local-command namespace. */
export function ServicePanel(props: ServicePanelProps) {
  const allowSynthetic = process.env.EXPO_PUBLIC_ENVIRONMENT !== 'production' && (props.allowSynthetic ?? true);
  const staticBrowser = Platform.OS === 'web' && process.env.EXPO_PUBLIC_REVIEW_STATIC === '1';
  const [baseUrl, setBaseUrl] = useState(staticBrowser ? '' : Platform.OS === 'web' ? '/' : 'http://127.0.0.1:4310');
  const [mode, setMode] = useState<'synthetic' | 'oidc'>(allowSynthetic ? 'synthetic' : 'oidc');
  const [account, setAccount] = useState('synthetic-manager-1');
  const [deviceAlias, setDeviceAlias] = useState('');
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const connectingRef = useRef(false);
  const autoConnection = useRef<{ journal: Journal; key: string } | null>(null);
  const matchId = props.matchId ?? (allowSynthetic ? props.match?.config.matchId ?? 'synthetic-roma-maple-2026-10-24' : '');
  const teamId = props.teamId ?? (allowSynthetic ? 'synthetic-roma-u10' : '');
  const seasonId = props.seasonId ?? (allowSynthetic ? 'synthetic-season-2026-27' : '');
  const controlled = props.initialConnection !== undefined;
  const selectedBaseUrl = props.initialConnection?.baseUrl ?? baseUrl;
  const selectedMode = props.initialConnection?.mode ?? mode;
  const selectedAccount = props.initialConnection?.account ?? account;
  const effectiveMode = allowSynthetic ? selectedMode : 'oidc';
  const configurationKey = JSON.stringify([selectedBaseUrl, effectiveMode, selectedAccount, controlled ? '' : deviceAlias, props.deviceId, teamId, seasonId, matchId]);
  const activeConfiguration = useRef(configurationKey);
  useLayoutEffect(() => { activeConfiguration.current = configurationKey; }, [configurationKey]);
  const platformAllowsCache = controllerCachePlatformAllowed(effectiveMode, Platform.OS);
  const openConnection = useCallback(async () => {
    if (connectingRef.current || !props.deviceId) return;
    connectingRef.current = true;
    setConnecting(true); setConnection(null); setConfigurationError(null);
    try {
      assertStaticReviewApiAddress(selectedBaseUrl, staticBrowser, Platform.OS === 'web' ? globalThis.location.origin : undefined);
      if (!platformAllowsCache) throw new Error('The connected match controller requires the native encrypted journal. This browser supports demo controller review only.');
      if (!matchId || !teamId || !seasonId) throw new Error('Select a service fixture and its team and season before opening its controller.');
      if (!allowSynthetic && selectedMode === 'synthetic') throw new Error('Demo identities are disabled in this environment. Choose connected sign-in.');
      const client = new LongBallServiceClient(selectedBaseUrl, async (url, options) => {
        if (effectiveMode === 'synthetic') {
          if (!allowSynthetic) throw new Error('Demo identities are disabled.');
          return fetch(url, { ...options, redirect: 'error', headers: { ...options.headers, Authorization: `Bearer ${selectedAccount}` } });
        }
        return connectedFetch(url.startsWith('/') && Platform.OS === 'web' ? new URL(url, globalThis.location.origin).toString() : url, options);
      });
      const session = effectiveMode === 'oidc' ? await getConnectedSessionSummary() : null;
      if (effectiveMode === 'oidc' && (!session || session.locked || session.expired)) throw new Error('Use an active unlocked connected sign-in before opening a controller cache.');
      const actor = await client.me<ControllerIdentity>();
      if (session && (actor.accountId !== session.accountId || actor.principal.issuer !== session.issuer)) throw new Error('Service identity differs from the unlocked connected account.');
      const wireDeviceId = effectiveMode === 'synthetic' ? (controlled ? '' : deviceAlias.trim()) || props.deviceId : `account-${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([session!.issuer, actor.accountId, client.baseUrl, props.deviceId]))}`;
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(wireDeviceId)) throw new Error('Use letters, numbers, underscores or hyphens for the device identifier.');
      const scope = controllerCacheScope(actor, { baseUrl: client.baseUrl, teamId, seasonId, matchId, deviceId: wireDeviceId }, Date.now());
      if (session && !controllerSessionAllowsCache(scope, session, Date.now())) throw new Error('Current sign-in is not eligible for this manager controller cache.');
      if (activeConfiguration.current !== configurationKey) return;
      setConnection({ baseUrl: client.baseUrl, mode: effectiveMode, syntheticAccount: effectiveMode === 'synthetic' ? selectedAccount : '', wireDeviceId, scope, configurationKey });
    } catch (error) { setConfigurationError(error instanceof Error ? error.message : 'Connection configuration is invalid.'); }
    finally { connectingRef.current = false; setConnecting(false); }
  }, [props.deviceId, selectedBaseUrl, staticBrowser, platformAllowsCache, matchId, teamId, seasonId, allowSynthetic, selectedMode, effectiveMode, selectedAccount, deviceAlias, controlled, configurationKey]);
  useEffect(() => {
    if (!controlled || !props.journal || !props.deviceId || !teamId || !seasonId || !matchId || connecting) return;
    if (autoConnection.current?.journal === props.journal && autoConnection.current.key === configurationKey) return;
    autoConnection.current = { journal: props.journal, key: configurationKey };
    void openConnection();
  }, [controlled, props.journal, props.deviceId, teamId, seasonId, matchId, connecting, configurationKey, openConnection]);
  return <View style={[styles.stack, props.fillScreen && { flex: 1, minHeight: 0 }]}>
    {controlled && <>
      {connecting && <Notice>Checking the selected manager account and match connection…</Notice>}
      {!props.journal && <Notice>The match journal must be opened before recording on this device.</Notice>}
      {configurationError && <><Notice tone="error">{configurationError}</Notice><Button label="Retry this controller connection" variant="secondary" disabled={connecting || !props.journal || !props.deviceId} onPress={() => { void openConnection(); }} /></>}
    </>}
    {(!controlled || showConnectionSettings) && <ConnectionSettings constrained={props.fillScreen}><Card>
      <Text style={typography.section}>{allowSynthetic ? 'Connected service rehearsal' : 'Connected match controller'}</Text>
      <Pill tone="info">{staticBrowser ? 'STATIC REVIEW · DEMO DATA STAYS LOCAL' : allowSynthetic ? 'DEMO DATA · CANONICAL HTTP' : 'AUTHENTICATED SERVICE · CANONICAL HTTP'}</Pill>
      {staticBrowser && <Notice>This lasting browser link runs demo journeys locally. It does not include the connected API. Paste a separately supplied service address below; a temporary full-API review link may be provided separately.</Notice>}
      <Text style={typography.body}>Download the selected service match and claim its controller. Access requires the current verified manager account for this team and season.</Text>
      <Text style={typography.label}>Service URL</Text>
      <TextInput accessibilityLabel="LongBall service URL" editable={!controlled} autoCapitalize="none" autoCorrect={false} value={selectedBaseUrl} onChangeText={setBaseUrl} style={styles.input} />
      <Text style={typography.muted}>{staticBrowser ? 'Enter the separately supplied HTTPS API address, or an explicit local development API address. This static host and / are not API endpoints.' : 'Use / with the combined browser/API review server, or the local API on port4310. A physical phone needs the development host URL or adb reverse; localhost means the phone itself.'}</Text>
      <View style={styles.row}>
        {allowSynthetic && <Button label={effectiveMode === 'synthetic' ? 'Demo identity · selected' : 'Demo identity'} disabled={controlled} variant={effectiveMode === 'synthetic' ? 'primary' : 'secondary'} onPress={() => { if (allowSynthetic) { setConnection(null); setMode('synthetic'); } }} />}
        <Button label={effectiveMode === 'oidc' ? 'Connected sign-in · selected' : 'Connected sign-in'} disabled={controlled} variant={effectiveMode === 'oidc' ? 'primary' : 'secondary'} onPress={() => { setConnection(null); setMode('oidc'); }} />
      </View>
      {allowSynthetic && effectiveMode === 'synthetic' ? <>
        <Text style={typography.muted}>These are public demo development identities, accepted only by the explicitly configured demo API. They grant no production access.</Text>
        <View style={styles.row}>{['synthetic-manager-1', 'synthetic-manager-2'].map(value => <Button key={value} label={value.endsWith('1') ? 'Manager A' : 'Manager B'} disabled={controlled} variant={selectedAccount === value ? 'primary' : 'secondary'} onPress={() => { if (allowSynthetic) { setConnection(null); setAccount(value); } }} />)}</View>
      </> : <Notice>Use the connected sign-in screen first. Its adapter supplies the current unlocked credential only to its configured API; bearer/refresh tokens are never copied into this document.</Notice>}
      {allowSynthetic && effectiveMode === 'synthetic' && <><Text style={typography.label}>Rehearsal device identifier</Text>
      <TextInput accessibilityLabel="Rehearsal device identifier" editable={!controlled} autoCapitalize="none" autoCorrect={false} value={controlled ? props.deviceId ?? '' : deviceAlias} placeholder={props.deviceId ?? 'Opening device journal…'} onChangeText={setDeviceAlias} style={styles.input} />
      <Text style={typography.muted}>Leave blank for this phone. For a second demo phone in the same browser, enter a distinct alias and use Manager B. Returning to an alias retains its wire sequence across controller epochs.</Text>
      </>}
      {!allowSynthetic && <Text style={typography.muted}>The recording device is enrolled separately for this verified account, issuer and API. A shared phone does not reuse another account’s device identity or controller cache.</Text>}
      {!controlled && configurationError && <Notice tone="error">{configurationError}</Notice>}
      {!platformAllowsCache && <Notice>Use the native application for the connected match controller. The browser keeps authenticated workspace views in memory; it does not open or persist a real account’s controller match in review storage. Demo browser rehearsal remains available in development.</Notice>}
      {!controlled && <Button label={connecting ? 'Verifying service identity…' : 'Open this service connection'} disabled={connecting || staticBrowser && !selectedBaseUrl.trim() || !platformAllowsCache || !props.journal || !props.deviceId || !matchId || !teamId || !seasonId} onPress={() => { void openConnection(); }} />}
    </Card></ConnectionSettings>}
    {connection && connection.configurationKey === configurationKey && (allowSynthetic || connection.mode === 'oidc') && connection.scope.matchId === matchId && connection.scope.teamId === teamId && connection.scope.seasonId === seasonId && <AuthorizedRehearsal key={controllerCacheDocumentId(connection.scope)} connection={connection} journal={props.journal} physicalDeviceId={props.deviceId} matchId={matchId} controlled={controlled} fillScreen={props.fillScreen} allowFictionalReview={controlled && allowSynthetic && connection.mode === 'synthetic'} onControllerState={props.onControllerState} />}
    {controlled && <Button label={showConnectionSettings ? 'Hide controller connection settings' : 'Controller connection settings'} testID="controller-connection-settings-toggle" variant="quiet" onPress={() => setShowConnectionSettings(value => !value)} />}
  </View>;
}

function ConnectionSettings({ constrained, children }: { constrained?: boolean; children: ReactNode }) {
  const layout = useWorkspaceLayout();
  const tablet = layout.mode === 'tablet' && layout.wide;
  return constrained ? <ScrollView style={[{ flexGrow: 0, maxHeight: "45%" }, tablet && styles.settingsWide]} keyboardShouldPersistTaps="handled">{children}</ScrollView> : <View style={tablet && styles.settingsWide}>{children}</View>;
}

interface RehearsalProps { connection: ConnectionConfig; journal: Journal | null; physicalDeviceId: string | null; matchId: string; controlled: boolean; fillScreen?: boolean; allowFictionalReview: boolean; onControllerState?: ServicePanelProps['onControllerState'] }

/** Do not mount useDocument (or expose its cached projection) before checking the unlocked account. */
function AuthorizedRehearsal(props: RehearsalProps) {
  const { onControllerState, matchId, connection: { wireDeviceId } } = props;
  const [authorized, setAuthorized] = useState(props.connection.mode === 'synthetic');
  useEffect(() => {
    if (props.connection.mode === 'synthetic' || !controllerCachePlatformAllowed(props.connection.mode, Platform.OS)) return;
    let cancelled = false;
    const check = async () => {
      try {
        const session = await getConnectedSessionSummary();
        if (!cancelled) setAuthorized(controllerSessionAllowsCache(props.connection.scope, session, Date.now()));
      } catch { if (!cancelled) setAuthorized(false); }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.connection]);
  useEffect(() => () => { onControllerState?.({ scope: 'connected-rehearsal', matchId, deviceId: wireDeviceId, epoch: null, lifecycle: 'closed', hasControl: false, reconciliationRequired: false, unsent: false, pendingNetwork: false, pendingCount: 0 }); }, [onControllerState, matchId, wireDeviceId]);
  if (!controllerCachePlatformAllowed(props.connection.mode, Platform.OS)) return <Notice>Real account controller storage is available in the native application. This browser does not load or persist that private match.</Notice>;
  if (!authorized) return <Notice>Controller cache is closed. Use the same active, unlocked verified manager account for this team and season, then reopen the connection.</Notice>;
  return <ConnectedRehearsal {...props} />;
}

function ConnectedRehearsal({ connection, journal, physicalDeviceId, matchId, controlled, fillScreen, allowFictionalReview, onControllerState }: RehearsalProps) {
  const layout = useWorkspaceLayout();
  const tablet = layout.mode === 'tablet' && layout.wide;
  const documentId = controllerCacheDocumentId(connection.scope);
  const document = useDocument<ConnectedMatchDocument>(journal, physicalDeviceId, documentId,
    () => createConnectedDocument(connection.wireDeviceId, matchId, connection.baseUrl),
    value => { assertConnectedDocument(value); if (value.deviceId !== connection.wireDeviceId || value.matchId !== matchId || value.baseUrl !== connection.baseUrl) throw new Error('Connected document identity differs; retain it and use the matching connection.'); });
  const [networkBusy, setNetworkBusy] = useState(false);
  const [plannerRetained, setPlannerRetained] = useState(false);
  const [showRecordingDetails, setShowRecordingDetails] = useState(false);
  const autoDownloadAttempted = useRef(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [authorityDenied, setAuthorityDenied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [quarantineCount, setQuarantineCount] = useState<number | null>(null);
  const [targetAccount, setTargetAccount] = useState('synthetic-account-manager-2');
  const [targetDevice, setTargetDevice] = useState('');
  const [transferId, setTransferId] = useState('');
  const [recoveryReason, setRecoveryReason] = useState('');
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [refereeTime, setRefereeTime] = useState('');
  const [refereeReason, setRefereeReason] = useState('');
  const [unchangedLineup, setUnchangedLineup] = useState(false);
  const [actionConfirmation, setActionConfirmation] = useState<{ label: string; command: ConnectedCommand } | null>(null);
  const [sample, setSample] = useState(clockSample);
  const [fictionalClockAcknowledged, setFictionalClockAcknowledged] = useState(false);
  const activeController = useRef<{epoch:number|null;confirmed:boolean;connection:ConnectionConfig}|null>(null);
  const [reviewDraft, setReviewDraft] = useState<{ matchId: string; sourceRevision: number; lineup: Allocation[] } | null>(null);
  const networkLock = useRef(false);
  const authorityDeniedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; authorityDeniedRef.current = true; }; }, []);
  const closeDeniedCache = useCallback((error: unknown) => {
    if (controllerAuthorityWasDenied(error)) { authorityDeniedRef.current = true; setAuthorityDenied(true); }
  }, []);
  const client = useMemo(() => {
    const authenticated: HttpFetch = async (url, options) => {
      if (connection.mode === 'oidc') {
        const session = await getConnectedSessionSummary();
        if (!controllerSessionAllowsCache(connection.scope, session, Date.now())) throw Object.assign(new Error('The unlocked account no longer authorizes this controller cache. Reopen the connection after sign-in.'), { code: 'CONTROLLER_SCOPE_DENIED' });
        const absolute = url.startsWith('/') && Platform.OS === 'web' ? new URL(url, globalThis.location.origin).toString() : url;
        return connectedFetch(absolute, options);
      }
      return fetch(url, { ...options, redirect: 'error', headers: { ...options.headers, Authorization: `Bearer ${connection.syntheticAccount}` } });
    };
    return new LongBallServiceClient(connection.baseUrl, authenticated);
  }, [connection]);
  const productionBrowserReadOnly = connection.mode === 'oidc' && Platform.OS === 'web';
  const current = document.state;
  const clockMapping = current?.clockMapping ?? null;
  const localMatch = current?.localState;
  const clock = current ? connectedClock(current, sample) : null;
  useEffect(() => { const interval = setInterval(() => setSample(clockSample()), 500); return () => clearInterval(interval); }, []);
  const epoch = current?.grant?.epoch ?? null;
  const controllerConfirmed = current?.controllerConfirmed ?? false;
  const reconciliationRequired = current?.reconciliationRequired ?? false;
  const pendingCount = current?.outbox.filter(entry => entry.disposition === 'pending').length ?? 0;
  const pendingNetwork = Boolean(current?.pendingRequest);
  const unsent = pendingCount > 0 || document.retryPending || document.conflict || plannerRetained;
  const documentReady = Boolean(current);
  useLayoutEffect(() => { activeController.current = { epoch, confirmed: controllerConfirmed && !reconciliationRequired && !authorityDenied, connection }; }, [epoch, controllerConfirmed, reconciliationRequired, authorityDenied, connection]);
  useEffect(() => { setReviewDraft(null); }, [epoch, controllerConfirmed, reconciliationRequired]);
  useEffect(() => { if (documentReady) onControllerState?.({ scope: 'connected-rehearsal', matchId, deviceId: connection.wireDeviceId, epoch, lifecycle: 'active', hasControl: controllerConfirmed && !reconciliationRequired && !productionBrowserReadOnly && !authorityDenied, reconciliationRequired, unsent, pendingNetwork, pendingCount }); }, [onControllerState, matchId, connection.wireDeviceId, epoch, controllerConfirmed, reconciliationRequired, productionBrowserReadOnly, authorityDenied, unsent, pendingNetwork, pendingCount, documentReady]);

  const run = useCallback(async (work: () => Promise<void>) => {
    if (networkLock.current || authorityDeniedRef.current) return;
    networkLock.current = true; setNetworkBusy(true); setNetworkError(null);
    try { await work(); } catch (error) { closeDeniedCache(error); setNetworkError(error instanceof Error ? error.message : 'Request failed. Original canonical records and request keys are retained.'); }
    finally { networkLock.current = false; setNetworkBusy(false); }
  }, [closeDeniedCache]);
  const runCapture = useCallback(async (work: () => Promise<void>) => {
    if (authorityDeniedRef.current) return;
    try { await work(); } catch (error) { closeDeniedCache(error); setNetworkError(error instanceof Error ? error.message : 'This local event was not saved. Existing records were retained.'); }
  }, [closeDeniedCache]);
  const download = useCallback(async () => {
    const actor = await client.me<ControllerIdentity>();
    const scope = controllerCacheScope(actor, connection.scope, Date.now());
    if (controllerCacheDocumentId(scope) !== controllerCacheDocumentId(connection.scope)) throw Object.assign(new Error('Authenticated account or scope changed. Close this controller cache and reopen the connection.'), { code: 'CONTROLLER_SCOPE_DENIED' });
    setIdentity(actor.accountId);
    let snapshot;
    try { snapshot = current?.grant ? await client.offlineBundle(matchId, connection.wireDeviceId, current.grant) : await client.download(matchId, connection.wireDeviceId); }
    catch (error) {
      if (error instanceof ServiceError && error.code === 'CONTROLLER_REQUIRED') {
        await document.change(value => ({ ...value, controllerConfirmed: false, authoritativeDownloadRequired: true, captureBlockedUntilDownload: true }), 'connected.controller.refresh_required');
        // A former recorder may still be a current assigned manager. This explicit
        // downgrade only refreshes viewing; old grant/outbox bytes remain retained.
        const observed = await client.download(matchId, connection.wireDeviceId);
        assertControllerDownloadScope(connection.scope, observed);
        const viewed = await document.change(value => mergeDownload(value, observed, { observationOnly: true }), 'connected.match.observation_refreshed');
        if (viewed) setNotice('Recording authority changed. Refreshed the accepted match for viewing only; original local records remain retained. Use explicit handover or recovery to record again.');
        return;
      }
      throw error;
    }
    assertControllerDownloadScope(connection.scope, snapshot);
    const saved = await document.change(value => mergeDownload(value, snapshot), 'connected.match.downloaded');
    if (saved) setNotice('Downloaded the accepted service snapshot. Pending or quarantined local candidates were preserved.');
  }, [client, matchId, connection.wireDeviceId, connection.scope, document, current?.grant]);
  useEffect(() => {
    // Re-entering from Schedule may follow a newly saved preparation checkpoint.
    // Always refresh this controlled entry through the preserving merge, including
    // when a previous visit already cached the unprepared match.
    if (!controlled || !current || autoDownloadAttempted.current || networkBusy || document.busy || document.retryPending || document.conflict) return;
    autoDownloadAttempted.current = true;
    void run(download);
  }, [controlled, current, networkBusy, document.busy, document.retryPending, document.conflict, run, download]);
  const execute = useCallback(async (snapshot: ConnectedMatchDocument) => {
    if (authorityDeniedRef.current) throw new Error('Controller cache closed after access was denied. Reopen the connection after sign-in.');
    if (productionBrowserReadOnly) throw new Error('Connected browser sign-in supports read-only review. Use the native encrypted journal for connected recording, or the demo mode for a full browser rehearsal.');
    const retained = snapshot.pendingRequest;
    if (!retained) throw new Error('No retained HTTP request to send.');
    try {
      const reply = await client.execute(retained, snapshot.grant);
      const acknowledged: { document: ConnectedMatchDocument | null } = { document: null };
      const saved = await document.change(value => {
        if (value.pendingRequest?.idempotencyKey !== retained.idempotencyKey) throw new Error('Response differs from the retained request; preserve both for reconciliation.');
        const next = applyMutationResponse(value, reply, new Date().toISOString());
        acknowledged.document = next;
        return next;
      }, 'connected.request.acknowledged');
      if (saved) {
        if (retained.kind !== 'handover') {
          try {
            const grant = acknowledged.document?.grant;
            const acceptedSnapshot = grant ? await client.offlineBundle(matchId, connection.wireDeviceId, grant) : await client.download(matchId, connection.wireDeviceId);
            assertControllerDownloadScope(connection.scope, acceptedSnapshot);
            const merged = await document.change(value => mergeDownload(value, acceptedSnapshot), 'connected.accepted_projection.downloaded');
            if (!merged) throw new Error('The authoritative snapshot was not committed locally; retain the receipt and retry the local save.');
            setNotice('Service receipt and authoritative actor-bound projection downloaded. Accepted and quarantined records remain separate.');
          } catch (error) {
            closeDeniedCache(error);
            setNotice('Service receipt saved. Download the current accepted snapshot to obtain its authoritative audit; original wire records remain retained.');
          }
        } else setNotice('Service response saved. Controller capability is retained without displaying it.');
      }
    } catch (error) {
      if (error instanceof ServiceError) {
        try { await document.change(value => settleDefiniteRefusal(value, error, new Date().toISOString()), 'connected.request.refused'); } catch { /* Auth/network uncertainty retains the exact original request. */ }
      }
      throw error;
    }
  }, [client, document, productionBrowserReadOnly, matchId, connection.wireDeviceId, connection.scope, closeDeniedCache]);
  const request = useCallback(async (kind: DurableRequest['kind'], details: Record<string, unknown> = {}) => {
    if (authorityDeniedRef.current) throw new Error('Controller cache closed after access was denied. Reopen the connection after sign-in.');
    if (productionBrowserReadOnly) throw new Error('Use the native encrypted journal for connected controller recording.');
    let prepared: ConnectedMatchDocument | null = null;
    const saved = await document.change(value => { prepared = prepareServiceRequest(value, kind, randomUUID(), details); return prepared; }, 'connected.request.prepared');
    if (saved && prepared) await execute(prepared);
  }, [document, execute, productionBrowserReadOnly]);
  const exchangeClock = useCallback(async () => {
    const origin = activeController.current, grant = current?.grant;
    if (!origin?.confirmed || !grant) throw new Error('Claim the current controller and download its accepted checkpoint before establishing clock evidence.');
    const expectedContinuity = readClock().continuityId;
    const assertCurrent = () => {
      const active = activeController.current;
      if (!mountedRef.current || authorityDeniedRef.current || active?.connection !== origin.connection || !active.confirmed || active.epoch !== origin.epoch || readClock().continuityId !== expectedContinuity) throw new Error('The account, controller or continuous clock changed. Local recording is preserved; start a new exchange.');
    };
    const mapping = await establishContinuousClockMapping({
      mutate: (path, body, idempotencyKey) => client.execute({ kind: 'clock_exchange', path, body, idempotencyKey }, grant),
      observe: () => { const observed = readClock(); return { sample: { monotonicMs: observed.monotonicMs, sessionId: observed.continuityId, wallTimeMs: Date.now() }, verifiedContinuous: observed.verifiedContinuous }; },
      nextId: randomUUID, assertCurrent,
    }, { matchId, deviceId: connection.wireDeviceId, controllerEpoch: grant.epoch }, { permitFictionalSessionClock: connection.mode === 'synthetic' && fictionalClockAcknowledged });
    assertCurrent();
    const saved = await document.change(value => retainClockMapping(value, mapping, clockSample()), 'connected.clock_mapping.retained');
    assertCurrent();
    if (!saved) throw new Error('The clock receipt was not durably retained. Retry the protected local save before relying on its finish evidence.');
    setNotice('Server-time exchange completed for this controller and continuous clock session. The server will validate its policy, expiry and finish event; local recording never waits for this exchange.');
  }, [client, current?.grant, matchId, connection.wireDeviceId, connection.mode, fictionalClockAcknowledged, document]);
  const record = useCallback(async (command: ConnectedCommand) => {
    if (productionBrowserReadOnly || authorityDeniedRef.current) return false;
    const capturedSample = clockSample(), eventId = randomUUID();
    try {
      const session = connection.mode === 'oidc' ? await getConnectedSessionSummary() : null;
      if (connection.mode === 'oidc' && !controllerSessionAllowsCache(connection.scope, session, Date.now())) throw Object.assign(new Error('The active account no longer authorizes recording into this controller cache.'), { code: 'CONTROLLER_SCOPE_DENIED' });
      const journalEvidence = connection.mode === 'oidc' ? await journal?.getDiagnostics() ?? null : null;
      if (!mountedRef.current || authorityDeniedRef.current) return false;
      const saved = await document.change(value => connection.mode === 'oidc'
        ? queueNativeLiveCommand(value, command, capturedSample, eventId, { platform: Platform.OS, eligible: !authorityDeniedRef.current && controllerSessionAllowsCache(connection.scope, session, Date.now()) && value.controllerConfirmed && !value.reconciliationRequired, journalEvidence })
        : queueConnectedCommand(value, command, capturedSample, eventId), 'connected.event.queued');
      if (saved) setNotice('Match event saved on this device. It remains pending until the service acknowledges it.');
      return saved;
    } catch (error) { closeDeniedCache(error); setNetworkError(error instanceof Error ? error.message : 'This event was not saved. Existing records were retained.'); return false; }
  }, [document, productionBrowserReadOnly, connection, journal, closeDeniedCache]);
  const busy = networkBusy || document.busy;
  const captureBusy = document.busy || document.retryPending || document.conflict;
  const rejected = current?.outbox.filter(entry => entry.disposition === 'quarantined') ?? [];
  const editable = !productionBrowserReadOnly && !authorityDenied && !document.retryPending && !document.conflict && Boolean(current && canCaptureConnectedEvents(current));
  const fictionalEditor = allowFictionalReview && connection.mode === 'synthetic' && Platform.OS === 'web' && process.env.EXPO_PUBLIC_ENVIRONMENT !== 'production';
  const sharedEditorAvailable = fictionalEditor || connection.mode === 'oidc' && Platform.OS !== 'web';
  const reviewClockAction = (action: 'start' | 'pause' | 'resume' | 'end') => {
    if (!localMatch || captureBusy || !editable) return;
    if (action === 'start' && ['preparation', 'half_time'].includes(localMatch.status)) setActionConfirmation({ label: `Start the ${localMatch.status === 'half_time' ? 'second' : 'first'} half and commit this staged lineup now?`, command: { type: 'half.started' } });
    else if (action === 'pause' && localMatch.status.endsWith('_running') && !clock?.recoveryRequired) setActionConfirmation({ label: 'Pause only if play is actually excluded by the referee clock. This is not a phone-use pause.', command: { type: 'half.paused' } });
    else if (action === 'resume' && localMatch.status.endsWith('_paused')) setActionConfirmation({ label: 'Resume the same half when the referee clock resumes?', command: { type: 'half.resumed' } });
    else if (action === 'end' && (localMatch.status.endsWith('_running') || localMatch.status.endsWith('_paused')) && !clock?.recoveryRequired) setActionConfirmation({ label: `End ${localMatch.half === 1 ? 'first half' : 'match'} at active ${formatMs(clock?.halfActiveMs ?? localMatch.halfActiveMs)} and score ${localMatch.score.for}–${localMatch.score.against}?`, command: { type: 'half.ended' } });
  };
  const clockActionReview = actionConfirmation && <View style={styles.stack}><Notice tone="warning">{actionConfirmation.label}</Notice><Button label="Confirm the actual event now" disabled={captureBusy || !editable} onPress={() => { const command = actionConfirmation.command; void record(command).then(saved => { if (saved) setActionConfirmation(null); }); }} /><Button label="Cancel review" variant="quiet" onPress={() => setActionConfirmation(null)} /></View>;
  let preparationRequired = false;
  if (controlled && localMatch) {
    try { assertSavedMatchRoster(localMatch); }
    catch { preparationRequired = true; }
  }
  if (authorityDenied) return <Notice tone="error">Controller cache closed because the service or current account denied access. Private match details and recording controls are hidden. Saved events and uncertain requests remain retained; reopen this connection with an authorised manager sign-in.</Notice>;
  const recordingStatus = (controlled && <Card style={{ padding: 10, gap: 6 }}>
      <Text style={typography.label} testID="connected-recording-status">{current?.controllerConfirmed ? layout.mode === 'tablet' ? 'Recording on this device' : 'Recording on this phone' : 'Viewing the accepted match'}</Text>
      {current?.controllerConfirmed && <Text style={typography.muted}>{pendingCount ? `Saved on this ${layout.mode === 'tablet' ? 'device' : 'phone'} · ${pendingCount} waiting to sync` : current.authoritativeDownloadRequired ? 'Receipt saved · accepted checkpoint needs refreshing' : rejected.length ? 'Saved history needs review' : 'Up to date with the service'}</Text>}
      {(networkError || document.error) && <Notice tone="error">{networkError || document.error}</Notice>}
      {notice && (!current?.controllerConfirmed || showRecordingDetails || current.authoritativeDownloadRequired || current.reconciliationRequired) && <Notice>{notice}</Notice>}
      {preparationRequired && <Notice tone="warning">Open this fixture in Schedule and choose Open match preparation to save its formation and player snapshots before taking control.</Notice>}
      {!localMatch && <Button label="Open the selected match" testID="recording-download" disabled={busy || !current} onPress={() => { void run(download); }} />}
      {!current?.controllerConfirmed && !current?.controllerObservation && <Button label="Take control of this match" testID="recording-acquire" disabled={busy || productionBrowserReadOnly || !localMatch || preparationRequired || Boolean(current?.pendingRequest)} onPress={() => { void run(() => request('acquire')); }} />}
      {current?.controllerConfirmed && pendingCount > 0 && <Button label={`Save ${pendingCount} recorded match changes`} testID="recording-upload" disabled={busy || productionBrowserReadOnly || Boolean(current.pendingRequest)} onPress={() => { void run(() => request('upload')); }} />}
      {current?.pendingRequest && <Button label="Retry retained match request" disabled={busy || productionBrowserReadOnly} onPress={() => { void run(() => execute(current)); }} />}
      {document.retryPending && <Button label="Retry local document save" onPress={() => { void document.retry(); }} />}
      {document.conflict && <Button label="Reload saved document; retain rejected branch" onPress={document.reload} />}
      {current?.reconciliationRequired && <Notice tone="warning">Recording is paused for reconciliation. The saved local and accepted records are retained separately; review recording details.</Notice>}
      {current?.controllerConfirmed && clock?.recoveryRequired && <Notice tone="warning">Time needs checking. Open recording details to record a referee-confirmed checkpoint.</Notice>}
      {!fillScreen && <Button label={showRecordingDetails ? 'Hide recording and sync details' : 'Recording and sync details'} testID="controller-recording-details" variant="quiet" onPress={() => setShowRecordingDetails(value => !value)} />}
    </Card>);
  const acceptedView = (current && !current.controllerConfirmed && <AcceptedMatchView view={acceptedMatchView(current, sample.wallTimeMs)} accountId={connection.scope.accountId} deviceId={connection.wireDeviceId} busy={busy || productionBrowserReadOnly || document.retryPending || Boolean(document.conflict)} pending={Boolean(current.pendingRequest)} onRefresh={() => { void run(download); }} onOpenDetails={() => setShowRecordingDetails(true)} onAccept={(reference) => { void run(() => request('accept', { transferId: reference })); }} />);
  const recordingDetails = <>
    {(!controlled || showRecordingDetails) && <View style={[styles.stack, tablet && styles.detailsGrid]} testID="controller-recording-details-layout">
    <Card style={tablet && styles.detailsColumn}>
      <Text style={typography.section}>Canonical connection</Text>
      {productionBrowserReadOnly && <Notice>Connected browser sign-in provides read-only review. Use a native development build for the encrypted controller journal, or choose the demo identity mode for the complete browser rehearsal.</Notice>}
      <Text style={typography.muted}>Device {connection.wireDeviceId} · {identity ?? 'identity not checked'} · {connection.mode === 'synthetic' ? 'demo development identity' : 'configured connected sign-in'}</Text>
      {(networkError || document.error) && <Notice tone="error">{networkError || document.error}</Notice>}
      {document.retryPending && <Button label="Retry local document save" onPress={() => { void document.retry(); }} />}
      {document.conflict && <Button label="Reload saved document; retain rejected branch" onPress={document.reload} />}
      {notice && <Notice>{notice}</Notice>}
      <Button label="Download accepted service match" variant="secondary" disabled={busy || !current} onPress={() => { void run(download); }} />
      <Button label="Acquire controller for this device" disabled={busy || productionBrowserReadOnly || !current?.localState || Boolean(current.pendingRequest)} onPress={() => { void run(() => request('acquire')); }} />
      {current && <>
        <Text style={typography.label}>Server revision {current.acceptedRevision} · local wire sequence {current.allocatedSequence} · epoch {current.grant?.epoch ?? 'none'}</Text>
        <Text style={typography.body}>{current.controllerConfirmed ? 'Controller capability confirmed at the last service check.' : 'This device has no currently confirmed writing capability.'}</Text>
        <Text style={typography.muted}>Offline revocation cannot be detected immediately. Reconnect to check the server epoch. The downloaded server timestamp is an observation, not a verified native UTC mapping.</Text>
        {current.outbox.some(entry => entry.disposition === 'pending' && entry.envelope.engineVersion !== ENGINE_VERSION) && <Notice tone="warning">An older-engine pending stream remains byte-for-byte retained. Upload its original request for explicit version quarantine/review. This build will not relabel those events or mix them with new-engine capture. Accepted history and reserved device sequences remain intact.</Notice>}
        <Text style={typography.body}>{pendingCount} pending · {rejected.length} retained quarantine · {current.outbox.filter(entry => entry.disposition === 'accepted').length} acknowledged</Text>
        <Button label="Upload pending canonical events" disabled={busy || productionBrowserReadOnly || !pendingCount || Boolean(current.pendingRequest)} onPress={() => { void run(() => request('upload')); }} />
        {current.pendingRequest && <Button label={`Retry same ${current.pendingRequest.kind} request`} disabled={busy || productionBrowserReadOnly} onPress={() => { void run(() => execute(current)); }} />}
        {current.reconciliationRequired && <Notice tone="warning">Reconciliation is required. The local candidate and accepted snapshot stay separate; normal recording is blocked. Read the quarantined events and review the accepted checkpoint explicitly.</Notice>}
        {current.authoritativeDownloadRequired && <Notice tone="warning">{current.captureBlockedUntilDownload ? 'Download this controller’s authoritative snapshot before recording.' : 'The accepted actor-bound audit still needs a download. The held controller can continue saving actual events to its local candidate.'} Choosing the accepted branch waits for that download. Saved receipts and original events remain retained.</Notice>}
        {current.pendingRequest?.kind === 'upload' && <Notice>The original upload and key stay fixed. Actual clock, lineup and goal events can continue saving locally behind that batch while its receipt is uncertain.</Notice>}
        {current.acceptedState && !current.authoritativeDownloadRequired && current.acceptedState.revision === current.acceptedRevision && !pendingCount && !current.pendingRequest && <Button label="Select accepted checkpoint; retain candidate audit" variant="secondary" disabled={busy} onPress={() => { void document.change(selectAcceptedBranch, 'connected.accepted_branch.selected'); }} />}
      </>}
      <Text style={typography.label}>Continuous finish-time evidence</Text>
      <Text style={typography.muted}>A downloaded UTC timestamp is only an observation. This exchange measures server-time bounds against the phone’s current continuous clock. It does not pause play or block offline event capture. A reboot, controller change or uncertain clock needs a new exchange. A new mapping applies to future events; already queued full-time records keep their original evidence.</Text>
      {connection.mode === 'synthetic' && <Button label={fictionalClockAcknowledged ? 'Demo session-clock experiment acknowledged' : 'Acknowledge demo session-clock experiment'} variant="secondary" onPress={() => setFictionalClockAcknowledged(value => !value)} />}
      <Button label="Establish continuous server-time evidence" testID="clock-exchange" variant="secondary" disabled={busy || !editable || connection.mode === 'synthetic' && !fictionalClockAcknowledged} onPress={() => { void run(exchangeClock); }} />
      {clockMapping && clockMapping.controllerEpoch === epoch && clockMapping.continuityId === sample.sessionId && <Notice>Exchange received under {clockMapping.policyId}; server validity ends {formatUkDateTime(clockMapping.validUntilMs)}. Finish-time acceptance is checked by the service. This evidence does not approve competition sharing or award policy.</Notice>}
      <Button label="Read service quarantine" variant="secondary" disabled={busy || !current} onPress={() => { void run(async () => { const result = await client.quarantine(matchId); setQuarantineCount(result.items.length); }); }} />
      {quarantineCount !== null && <Text style={typography.muted}>{quarantineCount} retained service quarantine records. Review requires an authorised manager; no branch is discarded.</Text>}
      {rejected.map(entry => <Notice key={entry.envelope.eventId} tone="warning">Sequence {entry.envelope.clientSequence}: {entry.reason ?? 'requires review'}</Notice>)}
    </Card>
    {localMatch && current?.controllerConfirmed && <Card style={tablet && styles.detailsColumn}>
      <Text style={typography.section}>{connection.mode === 'synthetic' ? 'Connected match rehearsal' : 'Connected match'}</Text>
      <Text style={typography.body}>{localMatch.status.replaceAll('_', ' ')} · {localMatch.score.for}–{localMatch.score.against} · active {formatMs(clock?.matchActiveMs ?? localMatch.matchActiveMs)}</Text>
      <Notice tone="info">These controls write canonical events into this connected document. They do not turn the earlier local match into a synchronised match.</Notice>
      {clock?.recoveryRequired && <Notice tone="warning">Time needs checking. The last durable checkpoint is retained. Controller recovery and uncertain clocks require an audited referee checkpoint; this screen does not guess elapsed time.</Notice>}
      {clock?.recoveryRequired && editable && <View style={styles.stack}>
        <Text style={typography.label}>Referee-confirmed active half time · MM:SS</Text>
        <TextInput accessibilityLabel="Connected referee half time" value={refereeTime} onChangeText={setRefereeTime} placeholder="12:30" keyboardType="numbers-and-punctuation" style={styles.input} />
        <TextInput accessibilityLabel="Connected referee clock correction reason" value={refereeReason} onChangeText={setRefereeReason} placeholder="Trusted referee stopwatch/checkpoint evidence" style={styles.input} />
        <Button label={unchangedLineup ? 'Unchanged lineup/availability confirmed' : 'Confirm lineup and availability stayed unchanged'} variant={unchangedLineup ? 'primary' : 'secondary'} onPress={() => setUnchangedLineup(value => !value)} />
        <Button label="Record confirmed clock recovery" disabled={captureBusy || !unchangedLineup || !refereeReason.trim()} onPress={() => { void runCapture(async () => {
          const parsed = /^(\d{1,3}):([0-5]\d)$/.exec(refereeTime.trim());
          if (!parsed) throw new Error('Enter referee active half time as MM:SS, for example12:30.');
          await record({ type: 'clock.corrected', halfActiveMs: (Number(parsed[1]) * 60 + Number(parsed[2])) * 1000, reason: refereeReason.trim(), confirmUnchangedLineup: true });
        }); }} />
        <Text style={typography.muted}>If players changed during the gap, retain the branch for audited reconciliation. This action does not invent those changes or rewind already recorded time.</Text>
      </View>}
      {localMatch.status === 'preparation' && connection.mode === 'synthetic' && <>
        <Button label="Record demo squad present" variant="secondary" disabled={captureBusy || !editable} onPress={() => { void runCapture(async () => { for (const playerId of localMatch.config.selectedPlayerIds) if (!(await record({ type: 'attendance.recorded', playerId, status: 'present' }))) break; }); }} />
        <Button label="Stage first seven present players" variant="secondary" disabled={captureBusy || !editable} onPress={() => { void runCapture(async () => {
          const eligible = localMatch.config.selectedPlayerIds.filter(id => localMatch.attendance[id] === 'present' && localMatch.availability[id]);
          const keeper = localMatch.config.fixedKeeperId ?? localMatch.config.players.find(player => eligible.includes(player.id) && [1, 2].includes(player.goalkeeperChoice))?.id;
          if (!keeper || !eligible.includes(keeper) || eligible.length < localMatch.config.pitchPlaces) throw new Error('Confirm enough present available players and eligible goalkeeper cover first.');
          const ordered = [keeper, ...eligible.filter(id => id !== keeper)];
          const slots = localMatch.config.slots ?? Array.from({ length: localMatch.config.pitchPlaces }, (_, index) => ({ slotId: `wire-slot-${index}`, position: index === 0 ? 'GK' : 'CM' }));
          const lineup: Allocation[] = slots.map((slot, index) => ({ slotId: slot.slotId, position: slot.position, playerId: ordered[index] }));
          await record({ type: 'lineup.staged', lineup });
        }); }} />
      </>}
      {localMatch.status === 'preparation' && connection.mode === 'oidc' && <Notice>Confirm actual attendance and the saved formation below. Secure storage must pass its on-device check before any clock or event is saved.</Notice>}
      {!sharedEditorAvailable && <>
      {(localMatch.status === 'preparation' || localMatch.status === 'half_time') && <Button label={localMatch.status === 'half_time' ? 'Review second-half start' : 'Review kickoff'} disabled={captureBusy || !editable} onPress={() => reviewClockAction('start')} />}
      {localMatch.status.endsWith('_running') && <>
        <Button label="Review actual referee clock pause" variant="secondary" disabled={captureBusy || !editable || clock?.recoveryRequired} onPress={() => reviewClockAction('pause')} />
        {connection.mode === 'synthetic' && <Button label="Record demo team goal" variant="secondary" disabled={captureBusy || !editable || clock?.recoveryRequired} onPress={() => { void record({ type: 'goal.recorded', beneficiary: 'us', scorerPlayerId: localMatch.config.selectedPlayerIds[1], goalType: 'open_play', isOwnGoal: false }); }} />}
      </>}
      {localMatch.status.endsWith('_paused') && <Button label="Review actual clock resume" disabled={captureBusy || !editable} onPress={() => reviewClockAction('resume')} />}
      {(localMatch.status.endsWith('_running') || localMatch.status.endsWith('_paused')) && <Button label={localMatch.half === 1 ? 'Review manual half-time' : 'Review manual full-time'} variant="danger" disabled={captureBusy || !editable || clock?.recoveryRequired} onPress={() => reviewClockAction('end')} />}
      {clockActionReview}
      </>}
    </Card>}
    {localMatch && current && <View style={[styles.stack, tablet && styles.detailsColumn]}><HistoryReviewPanel match={localMatch} accepted={current.acceptedState} eligible={editable} busy={Boolean(captureBusy)} onCommand={record}
      client={client} journal={journal} physicalDeviceId={physicalDeviceId} documentId={documentId}
      verifyAuthority={async () => {
        const actor = await client.me<ControllerIdentity>();
        const scope = controllerCacheScope(actor, connection.scope, Date.now());
        if (controllerCacheDocumentId(scope) !== controllerCacheDocumentId(connection.scope)) throw Object.assign(new Error('Authenticated review scope changed. Reopen the connection.'), { code: 'CONTROLLER_SCOPE_DENIED' });
      }} onAuthorityFailure={closeDeniedCache} /></View>}
    {current && <Card style={tablet && styles.detailsColumn}>
      <Text style={typography.section}>Controller handover and recovery</Text>
      <Text style={typography.muted}>The development service supports handover before kickoff, while already genuinely paused, or at half-time. Running transfer requires a verified cross-device clock exchange and is explicitly refused.</Text>
      <TextInput accessibilityLabel="Handover target account" value={targetAccount} onChangeText={setTargetAccount} autoCapitalize="none" style={styles.input} />
      <TextInput accessibilityLabel="Handover target device" value={targetDevice} onChangeText={setTargetDevice} autoCapitalize="none" placeholder="Second demo device alias" style={styles.input} />
      <Button label="Offer control to the named manager/device" variant="secondary" disabled={busy || productionBrowserReadOnly || !current.controllerConfirmed || pendingCount > 0 || Boolean(current.pendingRequest) || localMatch?.status.endsWith('_running')} onPress={() => { void run(() => request('handover', { toAccountId: targetAccount.trim(), toDeviceId: targetDevice.trim() })); }} />
      {current.lastTransferId && <Text selectable style={typography.label}>Transfer id: {current.lastTransferId}</Text>}
      <TextInput accessibilityLabel="Transfer id to accept" value={transferId} onChangeText={setTransferId} autoCapitalize="none" placeholder="Transfer id from the offering device" style={styles.input} />
      <Button label="Accept addressed transfer on this device" variant="secondary" disabled={busy || productionBrowserReadOnly || !transferId.trim() || Boolean(current.pendingRequest)} onPress={() => { void run(() => request('accept', { transferId: transferId.trim() })); }} />
      <Text style={typography.label}>Failed-phone recovery · explicit review</Text>
      <TextInput accessibilityLabel="Controller recovery reason" value={recoveryReason} onChangeText={setRecoveryReason} multiline placeholder="Why the old controller cannot hand over" style={styles.input} />
      <Button label={recoveryConfirmed ? 'Unsynchronised-record risk acknowledged' : 'Acknowledge possible unsynchronised old records'} variant={recoveryConfirmed ? 'primary' : 'secondary'} onPress={() => setRecoveryConfirmed(value => !value)} />
      <Button label="Recover control; retain old branch for reconciliation" variant="danger" disabled={busy || productionBrowserReadOnly || !recoveryConfirmed || !recoveryReason.trim() || Boolean(current.pendingRequest)} onPress={() => { void run(() => request('recover', { reason: recoveryReason.trim(), confirmUnsynchronisedRisk: true })); }} />
      <Text style={typography.muted}>Recovery is not a silent history merge. Reboot, clock mapping, ordinary running handover and old-phone reconciliation still require the recorded device/operating evidence.</Text>
    </Card>}
    </View>}
  </>;
  const planner = localMatch && current && (<ConnectedPlanner policy={{ commit: record, busy: document.busy, retryPending: document.retryPending, conflict: Boolean(document.conflict), retry: document.retry, reload: document.reload, acceptedRevision: current.acceptedRevision }} match={localMatch} sample={sample} clock={clock} eligible={editable} persistence={{ journal, deviceId: physicalDeviceId, binding: { kind: 'connected', mode: connection.mode, controllerScope: connection.scope } }} onRetainedChange={setPlannerRetained} onReviewLineup={(lineup, sourceRevision) => {
      if (!editable || sourceRevision !== localMatch.revision) { setNetworkError('The match or controller changed. Replan before opening this suggested lineup.'); return; }
      setReviewDraft({ matchId: localMatch.config.matchId, sourceRevision, lineup: lineup.map(item => ({ ...item })) });
    }} />);
  const sharedEditor = localMatch && current?.controllerConfirmed && sharedEditorAvailable && (<ConnectedLiveEditor fillScreen={fillScreen} header={fillScreen ? recordingStatus : undefined} extraContent={<>{fillScreen && <Button label={showRecordingDetails ? 'Hide recording and sync details' : 'Recording and sync details'} testID="controller-recording-details" variant="quiet" onPress={() => setShowRecordingDetails(value => !value)} />}{planner}{fillScreen && recordingDetails}</>} mode={fictionalEditor ? 'fictional-review' : 'native'} match={localMatch} clock={clock} busy={captureBusy} onCommand={record} journal={journal} eligible={editable} teamLabel={localMatch.config.fixture?.teamName} onReviewClockAction={reviewClockAction} clockActionReview={clockActionReview} reviewDraft={reviewDraft} onReviewDraftConsumed={() => setReviewDraft(null)} />);
  if (fillScreen && sharedEditor) return sharedEditor;
  const content = <View style={styles.stack}>{recordingStatus}{acceptedView}{controlled && sharedEditor}{recordingDetails}{!controlled && sharedEditor}</View>;
  return fillScreen ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }} keyboardShouldPersistTaps="handled">{content}</ScrollView> : content;

}

function ConnectedPlanner({ match, sample, clock, eligible, persistence, policy, onRetainedChange, onReviewLineup }: { match: MatchState; sample: ClockSample; clock: ReturnType<typeof connectedClock>; eligible: boolean; persistence: PlannerPersistence; policy: PlannerPolicyPort; onRetainedChange: (retained: boolean) => void; onReviewLineup: (lineup: Allocation[], sourceRevision: number) => void }) {
  const model = usePlannerModel(match, sample, clock, { hasControl: eligible, alertOwner: `connected-planner-${match.config.matchId}`, persistence, onRetainedChange, policy });
  return <View style={styles.stack}>
    {!eligible && <Notice>Planning and reminders require the current confirmed controller and an authoritative downloaded checkpoint. Pending or quarantined records stay retained.</Notice>}
    <PlannerPanel model={model} onReviewLineup={onReviewLineup} />
  </View>;
}
const styles = StyleSheet.create({ stack: { gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, settingsWide: { width: '100%', maxWidth: 900, alignSelf: 'center' }, detailsGrid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' }, detailsColumn: { flexBasis: '48%', flexGrow: 1, minWidth: 0 }, input: { minHeight: 52, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.controlBorder, color: colors.ink, backgroundColor: colors.surface, fontSize: 16 } });
