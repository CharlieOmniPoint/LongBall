import { SpectatorPinEntry } from './SpectatorPinEntry';
import { InvitationRequestEntry } from './InvitationRequestEntry';
import { RoleThemeProvider } from '../ui/RoleTheme';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { discoverFictionalReview } from '@longball/application/review-entry';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';
import { DemoSessionAccessDenied, demoServiceUnavailableMessage, signInDemo, signOutDemo, verifyDemoSession, type DemoLoginSession } from '../platform/demo-login';
import { demoSessionDeadline, demoSessionExpired, type DemoSessionDeadline } from '../platform/demo-session-deadline';
import { demoSessionIdentityKey, prepareDemoSessionRenewal } from '../platform/demo-session-renewal';
import { Button, Card, colors, Notice, Pill, typography } from '../ui';
import { LongBallWordmark } from './EntryScreens';
import { FictionalReviewWorkspace } from './FictionalReviewWorkspace';

const monotonicNow = () => typeof performance === 'undefined' ? Date.now() : performance.now();
const isForeground = (nativeState = AppState.currentState) => (nativeState == null || nativeState === 'active') && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
const expiredMessage = 'Your demo session has ended. Sign in again to continue.';

/** Preauthorised demo accounts use a server-checked login, separate from club OIDC. */
export function DemoLoginApplication({ onBack, onNavigationGuardChange, initialMode = "team", invitationDestination, onInvitationHandled }: {
  onInvitationHandled?: () => void;
  initialMode?: "team"|"spectator"|"request";
  invitationDestination?: {teamId:string;seasonId:string;code:string};
  onBack: () => void;
  onNavigationGuardChange?: (guard: ((leave: () => void) => void) | null) => void;
}) {
  const [entryMode,setEntryMode] = useState(initialMode);
  const [entryService,setEntryService] = useState<{mode:string;attempt:number;api:string}|null>(null);
  const [entryRetry,setEntryRetry] = useState(0);
  const entryApi = entryService?.mode === entryMode && entryService.attempt === entryRetry ? entryService.api : null;
  const [username, setUsername] = useState('');
  const [passcode, setPasscode] = useState('');
  const [session, setSession] = useState<DemoLoginSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [displayRole, setDisplayRole] = useState<WorkspaceBinding['role'] | null>(null);
  const [foreground, setForeground] = useState(isForeground);
  const [accessCheck, setAccessCheck] = useState<'ready' | 'checking' | 'failed'>('ready');
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [verificationUsername, setVerificationUsername] = useState('');
  const [verificationPasscode, setVerificationPasscode] = useState('');
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const verificationContext = useRef<{ session: DemoLoginSession; scope: WorkspaceBinding | null } | null>(null);
  const cleanupPending = useRef(new Map<string, DemoLoginSession>());
  const [cleanupCount, setCleanupCount] = useState(0);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const backgroundCanceled = useRef<AbortController | null>(null);
  const resumeOperation = useRef<AbortController | null>(null);
  const revocations = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const sessionRef = useRef<DemoLoginSession | null>(null);
  const deadline = useRef<DemoSessionDeadline | null>(null);
  const foregroundRef = useRef(foreground);
  const selectedScope = useRef<WorkspaceBinding | null>(null);
  const generation = useRef(0);
  const passwordInput = useRef<ComponentRef<typeof TextInput>>(null);
  const verificationPasswordInput = useRef<ComponentRef<typeof TextInput>>(null);
  const insets = useSafeAreaInsets();

  const closeSession = useCallback((expected: DemoLoginSession, notice: string) => {
    if (sessionRef.current !== expected) return false;
    sessionRef.current = null; selectedScope.current = null; setDisplayRole(null); deadline.current = null; generation.current += 1;
    resumeOperation.current?.abort(); resumeOperation.current = null;
    operation.current?.abort(); operation.current = null;
    verificationContext.current = null; setVerificationOpen(false); setVerificationPasscode(''); setVerificationError(null); setBusy(false);
    cleanupPending.current.clear(); setCleanupCount(0); setCleanupBusy(false);
    setSession(null); setPasscode(''); setError(null); setMessage(notice); setAccessCheck('ready');
    onNavigationGuardChange?.(null);
    return true;
  }, [onNavigationGuardChange]);
  const sessionHasExpired = useCallback(() => !deadline.current || demoSessionExpired(deadline.current, Date.now(), monotonicNow()), []);
  const checkCurrentAccess = useCallback(async () => {
    const checking = sessionRef.current;
    if (!checking || !foregroundRef.current || verificationContext.current) return;
    if (sessionHasExpired()) { closeSession(checking, expiredMessage); return; }
    resumeOperation.current?.abort();
    const controller = new AbortController(); resumeOperation.current = controller;
    const scope = selectedScope.current;
    setAccessCheck('checking');
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await verifyDemoSession(checking, controller.signal, globalThis.fetch, Date.now, scope);
      if (!mounted.current || sessionRef.current !== checking || resumeOperation.current !== controller || !foregroundRef.current) return;
      if (selectedScope.current !== scope) { setAccessCheck('failed'); return; }
      if (sessionHasExpired()) { closeSession(checking, expiredMessage); return; }
      setAccessCheck('ready');
    } catch (cause) {
      if (!mounted.current || sessionRef.current !== checking || resumeOperation.current !== controller || !foregroundRef.current) return;
      if (cause instanceof DemoSessionAccessDenied || sessionHasExpired()) closeSession(checking, expiredMessage);
      else setAccessCheck('failed');
    } finally {
      clearTimeout(timer);
      if (resumeOperation.current === controller) resumeOperation.current = null;
    }
  }, [closeSession, sessionHasExpired]);
  const authorityScopeChanged = useCallback((scope: WorkspaceBinding | null) => { selectedScope.current = scope; setDisplayRole(scope?.role ?? null); }, []);

  useEffect(() => {
    mounted.current = true;
    const ending = revocations.current;
    return () => { mounted.current = false; operation.current?.abort(); resumeOperation.current?.abort(); for (const controller of ending) controller.abort(); };
  }, []);
  useEffect(() => () => onNavigationGuardChange?.(null), [onNavigationGuardChange]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = sessionRef.current;
      if (current && sessionHasExpired()) {
        if (verificationContext.current) {
          setAccessCheck('failed');
          setVerificationError(previous => previous ?? 'Your session has ended. Verify this account again, or sign out to close it.');
        } else closeSession(current, expiredMessage);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [closeSession, sessionHasExpired]);
  useEffect(() => {
    const changed = (next: boolean) => {
      if (next === foregroundRef.current) return;
      foregroundRef.current = next; setForeground(next);
      if (!next) {
        backgroundCanceled.current = operation.current;
        operation.current?.abort(); resumeOperation.current?.abort(); resumeOperation.current = null;
        setPasscode(''); setVerificationPasscode('');
        if (sessionRef.current) setAccessCheck('checking');
      } else void checkCurrentAccess();
    };
    const native = AppState.addEventListener('change', state => changed(isForeground(state)));
    const visibility = () => changed(isForeground());
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
    return () => {
      native.remove();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
    };
  }, [checkCurrentAccess]);

  useEffect(() => {
    if(entryMode==='team'||session)return;
    const controller=new AbortController();let current=true;
    void discoverFictionalReview({fictionalReviewChosen:true,fetch:globalThis.fetch,signal:controller.signal}).then(service => {
      if(!current)return;
      if(service.status==='available')setEntryService({mode:entryMode,attempt:entryRetry,api:service.apiBaseUrl});else setError(demoServiceUnavailableMessage(service.reason));
    }).catch(()=>{if(current)setError('The team service could not be reached. Please try again.');});
    return()=>{current=false;controller.abort();};
  },[entryMode,entryRetry,session]);
  const acceptSpectatorSession=(next:DemoLoginSession)=>{
    if(!mounted.current||!foregroundRef.current)return;
    deadline.current=demoSessionDeadline(next.expiresAtMs,Date.now(),monotonicNow());
    sessionRef.current=next;setAccessCheck('ready');setSession(next);setError(null);
    if(invitationDestination)onInvitationHandled?.();
  };
  const login = async () => {
    // The ref prevents two native/web submit events in the same render from starting competing sessions.
    if (operation.current || !foregroundRef.current) return;
    const controller = new AbortController(); operation.current = controller; backgroundCanceled.current = null;
    const attempt = ++generation.current;
    const captured = { username, passcode }; setPasscode(''); setBusy(true); setError(null); setMessage(null);
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const service = await discoverFictionalReview({ fictionalReviewChosen: true, fetch: globalThis.fetch, signal: controller.signal });
      if (service.status !== 'available') throw new Error(demoServiceUnavailableMessage(service.reason));
      const next = await signInDemo({ apiBaseUrl: service.apiBaseUrl, ...captured, signal: controller.signal });
      if (mounted.current && !controller.signal.aborted && operation.current === controller && generation.current === attempt && foregroundRef.current) {
        deadline.current = demoSessionDeadline(next.expiresAtMs, Date.now(), monotonicNow());
        sessionRef.current = next; setAccessCheck('ready'); setSession(next);
      }
    } catch (cause) {
      if (mounted.current && operation.current === controller && generation.current === attempt) setError(controller.signal.aborted ? backgroundCanceled.current === controller ? 'Sign-in was canceled while the app was in the background. Please try again.' : 'Sign-in took too long. Please try again.' : cause instanceof Error ? cause.message : 'Demo sign-in is unavailable. Please try again.');
    } finally {
      clearTimeout(timer);
      if (mounted.current && operation.current === controller) { operation.current = null; setBusy(false); }
    }
  };
  const endSession = useCallback(async (ending: DemoLoginSession): Promise<void> => {
    if (sessionRef.current) cleanupPending.current.set(ending.accessToken, ending);
    const controller = new AbortController(); revocations.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      await signOutDemo(ending, controller.signal);
      cleanupPending.current.delete(ending.accessToken);
    } finally {
      clearTimeout(timer); revocations.current.delete(controller);
      if (!sessionRef.current) cleanupPending.current.delete(ending.accessToken);
      if (mounted.current && sessionRef.current) setCleanupCount(cleanupPending.current.size);
    }
  }, []);
  const beginVerification = useCallback(() => {
    const current = sessionRef.current;
    if (!current || !foregroundRef.current || operation.current) return;
    resumeOperation.current?.abort(); resumeOperation.current = null;
    generation.current++;
    verificationContext.current = { session: current, scope: selectedScope.current };
    setVerificationUsername(username); setVerificationPasscode(''); setVerificationError(null);
    setVerificationOpen(true); setAccessCheck('checking');
  }, [username]);
  const cancelVerification = () => {
    generation.current++;
    operation.current?.abort(); operation.current = null; setBusy(false); setVerificationPasscode('');
    if (sessionHasExpired()) {
      setVerificationError('Your session has ended. Verify this account again, or sign out to close it.');
      return;
    }
    verificationContext.current = null; setVerificationOpen(false); setVerificationError(null); setAccessCheck('checking');
    void checkCurrentAccess();
  };
  const verifySignInAgain = async () => {
    const context = verificationContext.current;
    if (!context || operation.current || !foregroundRef.current || sessionRef.current !== context.session) return;
    const controller = new AbortController(); operation.current = controller; backgroundCanceled.current = null;
    const attempt = ++generation.current;
    const captured = { username: verificationUsername, passcode: verificationPasscode };
    setVerificationPasscode(''); setBusy(true); setVerificationError(null);
    const current = () => mounted.current && foregroundRef.current && !controller.signal.aborted && operation.current === controller && generation.current === attempt && verificationContext.current === context && sessionRef.current === context.session && selectedScope.current === context.scope;
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const next = await prepareDemoSessionRenewal({
        previous: context.session, scope: context.scope, ...captured,
        signal: controller.signal, isCurrent: current,
        port: { revoke: endSession },
      });
      if (!current()) { void endSession(next).catch(() => undefined); return; }
      // Install only the verified same actor/API. Stable workspace keys retain
      // its local drafts; current grants are rechecked again by its fresh load.
      deadline.current = demoSessionDeadline(next.expiresAtMs, Date.now(), monotonicNow());
      sessionRef.current = next; setSession(next);
      verificationContext.current = null; setVerificationOpen(false); setVerificationError(null); setAccessCheck('ready');
      void endSession(context.session).catch(() => undefined);
    } catch (cause) {
      if (mounted.current && operation.current === controller && generation.current === attempt && verificationContext.current === context) {
        setVerificationError(controller.signal.aborted
          ? backgroundCanceled.current === controller ? 'Verification was cancelled while the app was in the background. Please try again.' : 'Verification took too long. Please try again.'
          : cause instanceof Error ? cause.message : 'The sign-in could not be verified. Please try again.');
      }
    } finally {
      clearTimeout(timer);
      if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(false); }
    }
  };
  const retrySessionCleanup = async () => {
    if (cleanupBusy) return;
    setCleanupBusy(true);
    try { await Promise.all([...cleanupPending.current.values()].map(ending => endSession(ending).catch(() => undefined))); }
    finally { if (mounted.current) setCleanupBusy(false); }
  };
  const finishSignOut = () => {
    const leaving = sessionRef.current;
    const previous = [...cleanupPending.current.values()];
    if (!leaving || !closeSession(leaving, 'You are signed out.')) return;
    // Account locking is always available. Journals are retained; private views close immediately.
    // The workspace applies its own guard to normal navigation before calling onLeaveWorkspace.
    operation.current?.abort(); operation.current = null; setBusy(false);
    const attempt = generation.current;
    const controller = new AbortController(); revocations.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    void signOutDemo(leaving, controller.signal).catch(() => {
      if (mounted.current && generation.current === attempt && !sessionRef.current) setMessage('Signed out on this device. The service could not confirm ending the session.');
    }).finally(() => { clearTimeout(timer); revocations.current.delete(controller); });
    for (const ending of previous) void endSession(ending).catch(() => undefined);
  };
  if (session) {
    const ready = foreground && accessCheck === 'ready' && !verificationOpen;
    const identityKey = demoSessionIdentityKey(session);
    return (
      <View style={styles.root} testID="demo-signed-in">
        {!ready && <View style={[styles.sessionBar, { paddingTop: insets.top }]}>
          <View style={styles.flex}><Pill tone="muted">{({manager:"Manager",administrator:"Administrator",player:"Player",spectator:"Spectator"})[displayRole ?? session.role]}</Pill></View>
          <Button label="Sign out" accessibilityLabel="Sign out" icon="logout" iconOnly compact testID="demo-sign-out" variant="quiet" onPress={finishSignOut} />
        </View>}
        {verificationOpen && <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.verificationPage, { paddingBottom: insets.bottom + 20 }]} testID="demo-session-verification">
          <Card>
            <Text accessibilityRole="header" style={typography.section}>Verify sign-in again</Text>
            <Text style={typography.body}>Enter the details for the account already open. Your unsaved changes and requests stay on this device while access is checked.</Text>
            {!foreground && <Notice>Your team view stays hidden while the app is in the background.</Notice>}
            <Text style={typography.label}>Username</Text>
            <TextInput accessibilityLabel="Verification username" testID="demo-verify-username" value={verificationUsername} onChangeText={setVerificationUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" editable={!busy && foreground} maxLength={64} style={styles.input} returnKeyType="next" onSubmitEditing={() => verificationPasswordInput.current?.focus()} />
            <Text style={typography.label}>Password or passcode</Text>
            <TextInput ref={verificationPasswordInput} accessibilityLabel="Verification password or passcode" testID="demo-verify-passcode" value={verificationPasscode} onChangeText={setVerificationPasscode} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" editable={!busy && foreground} maxLength={128} style={styles.input} returnKeyType="go" onSubmitEditing={() => { void verifySignInAgain(); }} />
            {verificationError && <Notice tone="warning">{verificationError}</Notice>}
            {busy && <View style={styles.progress}><ActivityIndicator color={colors.brand} /><Text style={typography.body}>Verifying this account…</Text></View>}
            <Button label={busy ? 'Verifying…' : 'Verify sign-in'} testID="demo-verify-submit" disabled={!foreground || busy || !verificationUsername.trim() || !verificationPasscode} onPress={() => { void verifySignInAgain(); }} />
            <Button label="Cancel verification" testID="demo-verify-cancel" variant="quiet" disabled={!foreground} onPress={cancelVerification} />
          </Card>
        </ScrollView>}
        {!ready && !verificationOpen && <View style={styles.cover} testID="demo-session-cover" accessibilityLiveRegion="polite">
          <Card>
            <Text accessibilityRole="header" style={typography.section}>Confirming access</Text>
            {!foreground ? <Text style={typography.body}>Your team view is hidden while the app is in the background.</Text> : accessCheck === 'failed' ? <>
              <Notice tone="error">Current access could not be confirmed. Check your connection and retry.</Notice>
              <Button label="Retry access check" testID="demo-session-retry" onPress={() => { void checkCurrentAccess(); }} />
            </> : <View style={styles.progress}><ActivityIndicator color={colors.brand} /><Text style={typography.body}>Checking your current access…</Text></View>}
          </Card>
        </View>}
        {cleanupCount > 0 && <View style={styles.cleanup} testID="demo-session-cleanup"><Notice tone="warning">Ending a previous sign-in could not be confirmed. The account open here has not changed.</Notice><Button label={cleanupBusy ? 'Ending previous sign-ins…' : 'Retry ending previous sign-ins'} compact variant="secondary" testID="demo-session-cleanup-retry" disabled={cleanupBusy || !foreground} onPress={() => { void retrySessionCleanup(); }} /></View>}
        <View testID="demo-session-workspace" style={[styles.flex, !ready && styles.hidden]} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}>
          <FictionalReviewWorkspace
            key={identityKey}
            sessionIdentityKey={identityKey}
            active={ready}
            initialConnection={{ baseUrl: session.apiBaseUrl, mode: 'synthetic', account: session.accessToken }}
            initialRole={session.role}
            onSignOut={finishSignOut}
            onVerifySignIn={beginVerification}
            signOutTestID={ready ? "demo-sign-out" : undefined}
            onLeaveWorkspace={finishSignOut}
            onNavigationGuardChange={onNavigationGuardChange}
            onAuthorityScopeChange={authorityScopeChanged}
            invitationDestination={invitationDestination}
          />
        </View>
      </View>
    );
  }
  return (
    <RoleThemeProvider role={entryMode === "spectator" ? "spectator" : null}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} testID="demo-login-screen">
      <View style={styles.column}>
        <LongBallWordmark />
        <Pill tone="muted">ROMA U10</Pill>
        <Text accessibilityRole="header" style={typography.title}>{entryMode === "request" ? "Join your team" : "Welcome back"}</Text>
        <Text style={typography.body}>Sign in to see your team, fixtures and match day.</Text>
        {entryMode === "team" ? <Card>
          <Text style={typography.label}>Username</Text>
          <TextInput accessibilityLabel="Username" testID="demo-username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" editable={!busy} maxLength={64} style={styles.input} returnKeyType="next" onSubmitEditing={() => passwordInput.current?.focus()} />
          <Text style={typography.label}>Password or passcode</Text>
          <TextInput ref={passwordInput} accessibilityLabel="Password or passcode" testID="demo-passcode" value={passcode} onChangeText={setPasscode} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" editable={!busy} maxLength={128} style={styles.input} returnKeyType="go" onSubmitEditing={() => { void login(); }} />
          {error && <Notice tone="error">{error}</Notice>}
          {message && <Notice>{message}</Notice>}
          {busy && <View style={styles.progress}><ActivityIndicator color={colors.brand} /><Text style={typography.body}>Signing in…</Text></View>}
          <Button label="Sign in" testID="demo-login-submit" disabled={busy || !username.trim() || !passcode} onPress={() => { void login(); }} />
        </Card> : entryApi ? entryMode === 'spectator' ? <SpectatorPinEntry apiBaseUrl={entryApi} invitation={invitationDestination} onSignedIn={acceptSpectatorSession} onBack={() => setEntryMode('team')} /> : <InvitationRequestEntry apiBaseUrl={entryApi} onBack={() => setEntryMode('team')} /> : <Card>{error ? <><Notice tone="warning">{error}</Notice><Button label="Retry connection" onPress={() => setEntryRetry(value=>value+1)} /></> : <><ActivityIndicator color={colors.brand}/><Text style={typography.body}>Connecting to your team…</Text></>}</Card>}
        {entryMode === 'team' && <View style={{gap:8}}><Button label="Spectator passcode" testID="demo-open-spectator" variant="secondary" disabled={busy} onPress={()=>{setError(null);setPasscode('');setEntryMode('spectator');}}/><Button label="Request an invitation" testID="demo-request-invite" variant="quiet" disabled={busy} onPress={()=>{setError(null);setPasscode('');setEntryMode('request');}}/></View>}
        <Button label="Back to welcome" variant="quiet" disabled={busy} onPress={onBack} />
      </View>
    </ScrollView>
    </RoleThemeProvider>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: colors.canvas },
  flex: { flex: 1, minHeight: 0 },
  hidden: { display: 'none' },
  cover: { flex: 1, justifyContent: 'center', alignSelf: 'center', width: '100%', maxWidth: 520, padding: 20 },
  verificationPage: { flexGrow: 1, width: '100%', maxWidth: 520, alignSelf: 'center', padding: 20 },
  cleanup: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  sessionBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12, backgroundColor: colors.surface },
  page: { flexGrow: 1, paddingHorizontal: 20, backgroundColor: colors.canvas, alignItems: 'center' },
  column: { width: '100%', maxWidth: 480, gap: 18 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
