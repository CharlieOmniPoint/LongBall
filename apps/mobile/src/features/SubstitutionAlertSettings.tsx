import { useState } from 'react';
import { Switch, Text, TextInput, View } from 'react-native';
import { assertSubstitutionAlertSettings, DEFAULT_SUBSTITUTION_ALERTS, type SubstitutionAlertSettings as Settings } from '@longball/application/substitution-alerts';
import { Button, Card, Notice, typography, colors } from '../ui';
import { playSubstitutionAudio, prepareSubstitutionAudio, substitutionAudioCapability } from '../platform/substitution-audio';

type SettingsProps = { value?: Settings; scopeKey?: string; disabled: boolean; onSave: (settings: Settings) => Promise<boolean> };
export function SubstitutionAlertSettings(props: SettingsProps) {
  return <SubstitutionAlertSettingsDraft key={`${props.scopeKey ?? 'team'}:${JSON.stringify(props.value ?? DEFAULT_SUBSTITUTION_ALERTS)}`} {...props} />;
}
function SubstitutionAlertSettingsDraft({ value, disabled, onSave }: SettingsProps) {
  const [enabled, setEnabled] = useState(value?.enabled ?? DEFAULT_SUBSTITUTION_ALERTS.enabled);
  const [lead, setLead] = useState(String(value?.leadSeconds ?? DEFAULT_SUBSTITUTION_ALERTS.leadSeconds));
  const [volume, setVolume] = useState(String(Math.round((value?.volume ?? DEFAULT_SUBSTITUTION_ALERTS.volume) * 100)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const settings = () => {
    if (!lead.trim() || !volume.trim()) throw new Error('Enter the warning time and volume.');
    const next = { enabled, leadSeconds: Number(lead), volume: Number(volume) / 100 };
    assertSubstitutionAlertSettings(next); return next;
  };
  const run = async (save: boolean) => {
    if (disabled || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const next = settings();
      if (save) {
        if (await onSave(next)) setMessage('Team substitution alerts saved. Enable audio on each match-day device.');
      } else {
        await prepareSubstitutionAudio(); await playSubstitutionAudio(next.volume); setMessage('Test tone played. Device volume and mute settings still apply.');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Alert settings could not be applied.'); }
    finally { setBusy(false); }
  };
  const input = { borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 8, padding: 10, color: colors.ink, backgroundColor: colors.surface, fontSize: 16, minHeight: 44, width: 100 };
  return <Card>
    <Text style={typography.section}>Substitution audio</Text>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Switch accessibilityLabel="Enable team substitution audio" value={enabled} disabled={disabled || busy} onValueChange={setEnabled} /><Text style={typography.body}>Sound before the next change</Text></View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
      <View style={{ gap: 4 }}><Text style={typography.label}>Seconds before · 0–300</Text><TextInput accessibilityLabel="Substitution audio seconds before" keyboardType="number-pad" maxLength={3} editable={!disabled && !busy} value={lead} onChangeText={setLead} style={input} /></View>
      <View style={{ gap: 4 }}><Text style={typography.label}>Volume · 0–100%</Text><TextInput accessibilityLabel="Substitution audio volume percent" keyboardType="number-pad" maxLength={3} editable={!disabled && !busy} value={volume} onChangeText={setVolume} style={input} /></View>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Button label="Save team alerts" compact disabled={disabled || busy} testID="save-substitution-alerts" onPress={() => { void run(true); }} /><Button label="Test sound" compact variant="secondary" disabled={disabled || busy} onPress={() => { void run(false); }} /></View>
    <Text style={typography.muted}>Only the current Manager recording an active game receives the tone. Pausing, clock recovery or losing control cancels it. Each device must enable its own audio.</Text>
    <Text style={typography.muted}>{substitutionAudioCapability}</Text>
    {error && <Notice tone="warning">{error}</Notice>}{message && <Notice>{message}</Notice>}
  </Card>;
}
