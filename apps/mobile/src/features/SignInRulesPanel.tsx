import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { parseSignInRules, type SignInRules, type SignInRulesDto } from '@longball/application/identity-policy';
import { RetainedAction } from '@longball/application/retained-action';
import type { LongBallServiceClient } from '@longball/application/sync';
import { randomUUID } from '../platform/id';
import { parseSignInRulesDto } from '../platform/sign-in-rules';
import { Button, Card, Notice, colors, typography } from '../ui';
import { useRoleTheme } from '../ui/RoleTheme';

const endpoint = '/v1/administration/sign-in-rules';
type Change = { expectedRevision: number; rules: SignInRules };

/** Application policy stays separate from club settings and never handles a user's password. */
export function SignInRulesPanel({ client, active, onRetainedChange }: { client: LongBallServiceClient; active: boolean; onRetainedChange: (retained: boolean) => void }) {
  const theme = useRoleTheme();
  const [data, setData] = useState<SignInRulesDto | null>(null);
  const [draft, setDraft] = useState<SignInRules | null>(null);
  const [lengths, setLengths] = useState({ usernameMin: '', usernameMax: '', passwordMin: '' });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [retained] = useState(() => new RetainedAction<Change, SignInRulesDto>());
  const operation = useRef<AbortController | null>(null);
  const pending = useRef<Change | null>(null);
  const current = useRef(true);
  const enabled = useRef(active);
  const retainedListener = useRef(onRetainedChange);
  useLayoutEffect(() => {
    retainedListener.current = onRetainedChange;
    enabled.current = active;
  }, [onRetainedChange, active]);
  useEffect(() => {
    current.current = true;
    return () => { current.current = false; operation.current?.abort(); retainedListener.current(false); };
  }, []);
  useEffect(() => {
    if (!active) operation.current?.abort();
  }, [active]);
  const adopt = (value: SignInRulesDto) => {
    const rules = parseSignInRules(value.rules);
    setData({ ...value, rules });
    setDraft({ username: { ...rules.username }, password: { ...rules.password }, spectatorPin: { ...rules.spectatorPin } });
    setLengths({ usernameMin: String(rules.username.minLength), usernameMax: String(rules.username.maxLength), passwordMin: String(rules.password.minLength) });
  };
  const load = async () => {
    if (!enabled.current || operation.current || pending.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(null); setMessage(null);
    try {
      const value = parseSignInRulesDto(await client.request<unknown>(endpoint, { signal: controller.signal }));
      if (current.current && enabled.current && !controller.signal.aborted) adopt(value);
    } catch (cause) {
      if (current.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Sign-in rules could not be loaded.');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (current.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!enabled.current || operation.current || !data || !draft) return;
    let change: Change;
    try {
      change = pending.current ?? { expectedRevision: data.revision, rules: parseSignInRules({ ...draft, username: { ...draft.username, minLength: Number(lengths.usernameMin), maxLength: Number(lengths.usernameMax) }, password: { ...draft.password, minLength: Number(lengths.passwordMin) } }) };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the username and password lengths.'); return;
    }
    const controller = new AbortController(); operation.current = controller; pending.current = change;
    retainedListener.current(true);
    setBusy(true); setError(null); setMessage(null);
    try {
      const value = await retained.run(change, randomUUID, async (captured, key) => parseSignInRulesDto(await client.request<unknown>(endpoint, { signal: controller.signal, request: { path: endpoint, kind: 'upload', idempotencyKey: key, body: captured } })));
      pending.current = null;
      if (current.current && !controller.signal.aborted) {
        adopt(value); setUncertain(false); setMessage('Application sign-in rules saved. Existing accounts keep their current login details.');
      }
      retainedListener.current(false);
    } catch (cause) {
      const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
      const unknown = !(status >= 400 && status < 500 && ![408, 429].includes(status));
      if (!unknown) { pending.current = null; retainedListener.current(false); }
      if (current.current) {
        setUncertain(unknown);
        setError(unknown ? 'The service has not confirmed this update. Retry the same update when connected.' : cause instanceof Error ? cause.message : 'The update was refused. Reload the current rules before trying again.');
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (current.current) setBusy(false);
    }
  };
  const locked = !active || busy || uncertain;
  const toggle = (label: string, value: boolean, onChange: (value: boolean) => void) => <View style={styles.toggle} key={label}><Text style={[typography.body, styles.toggleText]}>{label}</Text><Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={locked} trackColor={{ true: theme.accent }} {...(Platform.OS === 'web' ? { activeThumbColor: theme.accent } : {})} thumbColor={Platform.OS !== 'web' && value ? theme.accent : undefined} /></View>;
  const length = (label: string, field: keyof typeof lengths) => <View style={styles.length} key={field}><Text style={typography.label}>{label}</Text><TextInput accessibilityLabel={label} value={lengths[field]} onChangeText={value => setLengths(previous => ({ ...previous, [field]: value.replace(/\D/g, '').slice(0, 3) }))} keyboardType="number-pad" editable={!locked} maxLength={3} style={styles.input} /></View>;
  return <Card testID="application-sign-in-rules">
    <View style={styles.heading}><Text style={typography.section}>Application sign-in rules</Text><Button compact variant="secondary" label={expanded ? 'Hide sign-in rules' : 'Manage sign-in rules'} testID="sign-in-rules-toggle" disabled={!active || busy} accessibilityState={{ expanded }} onPress={() => { setExpanded(value => !value); if (!data) void load(); }} /></View>
    <Text style={typography.muted}>Super Admin · applies across all clubs and account types when credentials are created or changed.</Text>
    {expanded && <>
      {error && <Notice tone="warning">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {!draft || !data ? <Text style={typography.body}>{busy ? 'Loading sign-in rules…' : 'Load the current application rules to edit them.'}</Text> : <>
        <Text style={typography.label}>Usernames</Text>
        <Text style={typography.muted}>Suggested first username: team + first name + surname initial, for example {draft.username.allowSeparators ? 'Roma.SebL' : 'RomaSebL'}. Sign-in ignores letter case. A short suffix resolves a duplicate username.</Text>
        <Text style={typography.muted}>Minimum length: 3–32. Maximum length: 8–40 and at least the minimum.</Text>
        <View style={styles.row}>{length('Minimum username length', 'usernameMin')}{length('Maximum username length', 'usernameMax')}</View>
        {toggle('Allow numbers in usernames', draft.username.allowNumbers, value => setDraft({ ...draft, username: { ...draft.username, allowNumbers: value } }))}
        {toggle('Allow dots, underscores and dashes', draft.username.allowSeparators, value => setDraft({ ...draft, username: { ...draft.username, allowSeparators: value } }))}
        <Text style={typography.label}>Passwords · Managers, administrators and Players</Text>
        <Text style={typography.muted}>Choose a minimum of 8–64 characters. Passwords may contain up to 128 characters.</Text>
        <View style={styles.row}>{length('Minimum password length', 'passwordMin')}</View>
        {([['requireUppercase', 'Require an uppercase letter'], ['requireLowercase', 'Require a lowercase letter'], ['requireNumber', 'Require a number'], ['requireSymbol', 'Require a symbol'], ['disallowUsername', 'Prevent the username in a password']] as const).map(([field, label]) => toggle(label, draft.password[field], value => setDraft({ ...draft, password: { ...draft.password, [field]: value } })))}
        <Text style={typography.label}>Spectator four-digit passcodes</Text>
        {toggle('Block easily guessed spectator codes', draft.spectatorPin.blockSimpleCodes, value => setDraft({ ...draft, spectatorPin: { blockSimpleCodes: value } }))}
        <Text style={typography.muted}>Spectators use four-digit passcodes. Other account types use passwords. Changing rules does not rename accounts or expire existing passwords.</Text>
        {data.provider.status !== 'applied' && <Notice tone="warning">{data.provider.detail}</Notice>}
        <View style={styles.row}><Button compact label={busy ? 'Saving…' : uncertain ? 'Retry same rules update' : 'Save application rules'} testID="sign-in-rules-save" disabled={!active || busy} onPress={() => void save()} /><Button compact variant="quiet" label="Reload current rules" disabled={locked} onPress={() => void load()} /></View>
        <Text style={typography.muted}>Rules version {data.revision}</Text>
      </>}
      {!data && <Button compact variant="quiet" label="Retry loading rules" disabled={!active || busy} onPress={() => void load()} />}
    </>}
  </Card>;
}
const styles = StyleSheet.create({
  heading: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  length: { flexBasis: 160, flexGrow: 1, gap: 6, maxWidth: 240 },
  input: { ...typography.body, minHeight: 48, padding: 10, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 8, backgroundColor: colors.surface },
  toggle: { flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'space-between' },
  toggleText: { flex: 1 },
});
