import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { discoverFictionalReview } from '@longball/application/review-entry';
import type { WorkspaceBinding } from '@longball/application/workspace-boundary';
import { DemoSessionAccessDenied, demoServiceUnavailableMessage, signInDemo, signOutDemo, verifyDemoSession, type DemoLoginSession } from '../platform/demo-login';
import { demoSessionDeadline, demoSessionExpired, type DemoSessionDeadline } from '../platform/demo-session-deadline';
import { Button, Card, colors, Notice, Pill, typography } from '../ui';
import { LongBallWordmark } from './EntryScreens';
import { FictionalReviewWorkspace } from './FictionalReviewWorkspace';

const monotonicNow = () => typeof performance === 'undefined' ? Date.now() : performance.now();
const isForeground = (nativeState = AppState.currentState) => (nativeState == null || nativeState === 'active') && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
const expiredMessage = 'Your demo session has ended. Sign in again to continue.';

/** Preauthorised demo accounts use a server-checked login, separate from club OIDC. */
export function DemoLoginApplication({ onBack, onNavigationGuardChange }: {
  onBack: () => void;
  onNavigationGuardChange?: (guard: ((leave: () => void) => void) | null) => void;
}) {
  const [username, setUsername] = useState('');
  const [passcode, setPasscode] = useState('');
  const [session, setSession] = useState<DemoLoginSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [foreground, setForeground] = useState(isForeground);
  const [accessCheck, setAccessCheck] = useState<'ready' | 'checking' | 'failed'>('ready');
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
  const insets = useSafeAreaInsets();

  const closeSession = useCallback((expected: DemoLoginSession, notice: string) => {
    if (sessionRef.current !== expected) return false;
    sessionRef.current = null; selectedScope.current = null; deadline.current = null; generation.current += 1;
    resumeOperation.current?.abort(); resumeOperation.current = null;
    setSession(null); setPasscode(''); setError(null); setMessage(notice); setAccessCheck('ready');
    onNavigationGuardChange?.(null);
    return true;
  }, [onNavigationGuardChange]);
  const sessionHasExpired = useCallback(() => !deadline.current || demoSessionExpired(deadline.current, Date.now(), monotonicNow()), []);
  const checkCurrentAccess = useCallback(async () => {
    const checking = sessionRef.current;
    if (!checking || !foregroundRef.current) return;
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
  const authorityScopeChanged = useCallback((scope: WorkspaceBinding | null) => { selectedScope.current = scope; }, []);

  useEffect(() => {
    mounted.current = true;
    const ending = revocations.current;
    return () => { mounted.current = false; operation.current?.abort(); resumeOperation.current?.abort(); for (const controller of ending) controller.abort(); };
  }, []);
  useEffect(() => () => onNavigationGuardChange?.(null), [onNavigationGuardChange]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = sessionRef.current;
      if (current && sessionHasExpired()) closeSession(current, expiredMessage);
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
        setPasscode('');
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
  const finishSignOut = () => {
    const leaving = sessionRef.current;
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
  };
  if (session) {
    const ready = foreground && accessCheck === 'ready';
    return (
      <View style={styles.root} testID="demo-signed-in">
        <View style={[styles.sessionBar, { paddingTop: insets.top }]}>
          <Text style={[typography.muted, styles.flex]}>Roma U10 · Demo</Text>
          <Button label="Sign out" testID="demo-sign-out" variant="quiet" onPress={finishSignOut} />
        </View>
        {!ready && <View style={styles.cover} testID="demo-session-cover" accessibilityLiveRegion="polite">
          <Card>
            <Text accessibilityRole="header" style={typography.section}>Confirming demo access</Text>
            {!foreground ? <Text style={typography.body}>Your team view is hidden while the app is in the background.</Text> : accessCheck === 'failed' ? <>
              <Notice tone="error">Current demo access could not be confirmed. Check your connection and retry.</Notice>
              <Button label="Retry access check" testID="demo-session-retry" onPress={() => { void checkCurrentAccess(); }} />
            </> : <View style={styles.progress}><ActivityIndicator color={colors.brand} /><Text style={typography.body}>Checking your current access…</Text></View>}
          </Card>
        </View>}
        <View testID="demo-session-workspace" style={[styles.flex, !ready && styles.hidden]} accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}>
          <FictionalReviewWorkspace
            key={`${session.accountId}:${session.expiresAtMs}`}
            active={ready}
            initialConnection={{ baseUrl: session.apiBaseUrl, mode: 'synthetic', account: session.accessToken }}
            initialRole={session.role}
            onLeaveWorkspace={finishSignOut}
            onNavigationGuardChange={onNavigationGuardChange}
            onAuthorityScopeChange={authorityScopeChanged}
          />
        </View>
      </View>
    );
  }
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} testID="demo-login-screen">
      <View style={styles.column}>
        <LongBallWordmark />
        <Pill tone="muted">ROMA U10 · DEMO</Pill>
        <Text accessibilityRole="header" style={typography.title}>Welcome back</Text>
        <Text style={typography.body}>Sign in to see your team, fixtures and match day.</Text>
        <Card>
          <Text style={typography.label}>Username</Text>
          <TextInput accessibilityLabel="Username" testID="demo-username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" editable={!busy} maxLength={64} style={styles.input} returnKeyType="next" onSubmitEditing={() => passwordInput.current?.focus()} />
          <Text style={typography.label}>Password or passcode</Text>
          <TextInput ref={passwordInput} accessibilityLabel="Password or passcode" testID="demo-passcode" value={passcode} onChangeText={setPasscode} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" editable={!busy} maxLength={128} style={styles.input} returnKeyType="go" onSubmitEditing={() => { void login(); }} />
          {error && <Notice tone="error">{error}</Notice>}
          {message && <Notice>{message}</Notice>}
          {busy && <View style={styles.progress}><ActivityIndicator color={colors.brand} /><Text style={typography.body}>Signing in…</Text></View>}
          <Button label="Sign in" testID="demo-login-submit" disabled={busy || !username.trim() || !passcode} onPress={() => { void login(); }} />
        </Card>
        <Button label="Back to welcome" variant="quiet" disabled={busy} onPress={onBack} />
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: colors.canvas },
  flex: { flex: 1, minHeight: 0 },
  hidden: { display: 'none' },
  cover: { flex: 1, justifyContent: 'center', alignSelf: 'center', width: '100%', maxWidth: 520, padding: 20 },
  sessionBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12, backgroundColor: colors.surface },
  page: { flexGrow: 1, paddingHorizontal: 20, backgroundColor: colors.canvas, alignItems: 'center' },
  column: { width: '100%', maxWidth: 480, gap: 18 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
