import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { discoverFictionalReview } from '@longball/application/review-entry';
import { signInDemo, signOutDemo, type DemoLoginSession } from '../platform/demo-login';
import { Button, Card, colors, Notice, Pill, typography } from '../ui';
import { LongBallWordmark } from './EntryScreens';
import { FictionalReviewWorkspace } from './FictionalReviewWorkspace';

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
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const guard = useRef<((leave: () => void) => void) | null>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);
  useEffect(() => () => onNavigationGuardChange?.(null), [onNavigationGuardChange]);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (session.expiresAtMs <= Date.now()) {
        setSession(null); setPasscode(''); guard.current = null; onNavigationGuardChange?.(null);
        setMessage('Your demo session has ended. Sign in again to continue.');
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [session, onNavigationGuardChange]);

  const login = async () => {
    if (busy) return;
    const controller = new AbortController(); operation.current = controller;
    const captured = { username, passcode }; setPasscode(''); setBusy(true); setError(null); setMessage(null);
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const service = await discoverFictionalReview({ fictionalReviewChosen: true, fetch: globalThis.fetch, signal: controller.signal });
      if (service.status !== 'available') throw new Error(service.message);
      const next = await signInDemo({ apiBaseUrl: service.apiBaseUrl, ...captured, signal: controller.signal });
      if (mounted.current && !controller.signal.aborted && operation.current === controller) setSession(next);
    } catch (cause) {
      if (mounted.current && operation.current === controller) setError(controller.signal.aborted ? 'Sign-in took too long. Please try again.' : cause instanceof Error ? cause.message : 'Demo sign-in is unavailable. Please try again.');
    } finally {
      clearTimeout(timer);
      if (mounted.current && operation.current === controller) { operation.current = null; setBusy(false); }
    }
  };
  const finishSignOut = () => {
    const leaving = session;
    if (!leaving) return;
      // Close private views immediately, while retaining independent unsent match records.
      setSession(null); setPasscode(''); guard.current = null; onNavigationGuardChange?.(null); setError(null); setMessage('You are signed out.');
      const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
      const timer = setTimeout(() => controller.abort(), 8000);
      void signOutDemo(leaving, controller.signal).catch(() => {
        if (mounted.current && operation.current === controller) setMessage('Signed out on this device. The service could not confirm ending the session.');
      }).finally(() => { clearTimeout(timer); if (operation.current === controller) operation.current = null; });
  };
  const logout = () => { if (guard.current) guard.current(finishSignOut); else finishSignOut(); };
  if (session) return (
    <View style={styles.root} testID="demo-signed-in">
      <View style={[styles.sessionBar, { paddingTop: insets.top }]}>
        <Text style={[typography.muted, styles.flex]}>Roma U10 · Demo</Text>
        <Button label="Sign out" testID="demo-sign-out" variant="quiet" onPress={logout} />
      </View>
      <FictionalReviewWorkspace
        key={`${session.accountId}:${session.expiresAtMs}`}
        initialConnection={{ baseUrl: session.apiBaseUrl, mode: 'synthetic', account: session.accessToken }}
        initialRole={session.role}
        onLeaveWorkspace={finishSignOut}
        onNavigationGuardChange={value => { guard.current = value; onNavigationGuardChange?.(value); }}
      />
    </View>
  );
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} testID="demo-login-screen">
      <View style={styles.column}>
        <LongBallWordmark />
        <Pill tone="muted">ROMA U10 · DEMO</Pill>
        <Text accessibilityRole="header" style={typography.title}>Welcome back</Text>
        <Text style={typography.body}>Sign in to see your team, fixtures and match day.</Text>
        <Card>
          <Text style={typography.label}>Username</Text>
          <TextInput accessibilityLabel="Username" testID="demo-username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" editable={!busy} maxLength={64} style={styles.input} returnKeyType="next" />
          <Text style={typography.label}>Password or passcode</Text>
          <TextInput accessibilityLabel="Password or passcode" testID="demo-passcode" value={passcode} onChangeText={setPasscode} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" editable={!busy} maxLength={128} style={styles.input} returnKeyType="go" onSubmitEditing={() => { void login(); }} />
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
  flex: { flex: 1 },
  sessionBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12, backgroundColor: colors.surface },
  page: { flexGrow: 1, paddingHorizontal: 20, backgroundColor: colors.canvas, alignItems: 'center' },
  column: { width: '100%', maxWidth: 480, gap: 18 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
