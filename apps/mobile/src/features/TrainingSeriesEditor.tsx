import { formatUkDate } from '@longball/application/uk-display';
import { useState } from 'react';
import { Switch, Text, TextInput, View } from 'react-native';
import { reducePreparation, type PreparationCommand, type PreparationState, type TrainingDraft } from '@longball/application/preparation';
import { trainingSeriesOccurrences, weeklyTrainingDates, type TrainingSeriesPayload } from '@longball/application/training-series';
import { retainedPreparationPlayers } from '@longball/application/preparation-presentation';
import { randomUUID } from '../platform/id';
import { Button, Card, Notice, Pill, typography } from '../ui';

export function TrainingSeriesEditor({ state, training, mode, disabled, sourceChanged = false, onSubmit, onClose }: {
  state: PreparationState; training: TrainingDraft; mode: 'create' | 'manage'; disabled: boolean;
  sourceChanged?: boolean;
  onSubmit: (command: PreparationCommand) => Promise<boolean>; onClose: () => void;
}) {
  const series = mode === 'manage' && training.recurrenceGroupId ? trainingSeriesOccurrences(state, training.seasonId, training.recurrenceGroupId) : [];
  const scheduled = series.filter(item => item.status === 'scheduled');
  const original = mode === 'manage' ? scheduled[0] ?? training : training;
  const [draft, setDraft] = useState({ ...original, expectedProfileIds: [...original.expectedProfileIds] });
  const [count, setCount] = useState('');
  const [action, setAction] = useState<'edit' | 'cancel'>('edit');
  const [preview, setPreview] = useState<(TrainingSeriesPayload & { id: string; expectedRevision: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const season = state.seasons.find(item => item.id === training.seasonId)!;
  const players = retainedPreparationPlayers(state, training.seasonId, original.expectedProfileIds);
  const review = () => {
    try {
      if (sourceChanged) throw new Error('Saved preparation changed. Keep this draft visible until you discard it and reopen the latest saved values.');
      let payload: TrainingSeriesPayload;
      if (mode === 'create') {
        const dates = weeklyTrainingDates(draft.date, /^\d+$/.test(count) ? Number(count) : NaN, season);
        const recurrenceGroupId = randomUUID();
        payload = { type: 'training.series_created', seasonId: training.seasonId, recurrenceGroupId, confirmOccurrences: true,
          occurrences: dates.map(date => ({ ...draft, id: randomUUID(), date, recurrenceGroupId, expectedProfileIds: [...draft.expectedProfileIds] })) };
      } else {
        if (!training.recurrenceGroupId) throw new Error('This occurrence has no training series.');
        const common = { seasonId: training.seasonId, recurrenceGroupId: training.recurrenceGroupId, occurrenceIds: scheduled.map(item => item.id), confirmOccurrences: true as const };
        payload = action === 'cancel' ? { ...common, type: 'training.series_cancelled' } : { ...common, type: 'training.series_updated', changes: { time: draft.time, venue: draft.venue, expectedProfileIds: [...draft.expectedProfileIds] } };
      }
      const command = { ...payload, id: randomUUID(), expectedRevision: state.revision };
      reducePreparation(state, command);
      setPreview(command); setError(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review the training dates and players.'); }
  };
  const previewRows = preview?.type === 'training.series_created' ? preview.occurrences : scheduled;
  const stale = preview !== null && preview.expectedRevision !== state.revision;
  return <View style={{ gap: 16 }}>
    <Text accessibilityRole="header" style={typography.section}>{mode === 'create' ? 'Weekly training series' : 'Scheduled occurrences in this series'}</Text>
    {error && <Notice tone="error">{error}</Notice>}
    {preview ? <>
      <Notice tone="warning">Review every listed date before confirming. {preview.type === 'training.series_cancelled' ? 'These scheduled occurrences will be cancelled.' : 'These occurrences will use the time, venue and expected players shown.'} Replies and actual attendance are retained.</Notice>
      {previewRows.map(item => <Card key={item.id}><Text style={typography.body}>{formatUkDate(item.date)} · {preview.type === 'training.series_created' ? item.time : preview.type === 'training.series_updated' ? preview.changes.time : item.time}</Text><Text style={typography.muted}>{preview.type === 'training.series_updated' ? preview.changes.venue || 'Venue not recorded' : item.venue || 'Venue not recorded'}</Text></Card>)}
      {preview.type !== 'training.series_cancelled' && <Text style={typography.body}>Expected players: {players.filter(item => (preview.type === 'training.series_created' ? preview.occurrences[0].expectedProfileIds : preview.changes.expectedProfileIds).includes(item.id)).map(item => item.displayName).join(', ') || 'None selected'}.</Text>}
      {stale && <Notice tone="error">The saved team records changed after this preview. Go back and review the current dates again.</Notice>}
      <Button testID="training-series-confirm" label={`Confirm ${previewRows.length} ${preview.type === 'training.series_cancelled' ? 'cancellations' : 'training occurrences'}`} disabled={disabled || stale || sourceChanged} onPress={() => { void onSubmit(preview); }} />
      <Button label="Back to series editor" variant="secondary" disabled={disabled} onPress={() => setPreview(null)} />
    </> : <>
      {mode === 'create' ? <>
        <SeriesField label="First training date (YYYY-MM-DD)" value={draft.date} disabled={disabled} onChange={date => setDraft(previous => ({ ...previous, date }))} />
        <SeriesField label="Number of weekly occurrences" value={count} disabled={disabled} onChange={setCount} />
        <Notice>Every seven calendar days at the local time shown. Review the actual dates, including dates around clock changes; no UTC offset is inferred.</Notice>
      </> : <>
        <Text style={typography.body}>{scheduled.length} scheduled occurrences. Each occurrence keeps its existing date and identity.</Text>
        <Button label="Edit scheduled occurrences" variant={action === 'edit' ? 'primary' : 'secondary'} disabled={disabled} onPress={() => setAction('edit')} />
        <Button label="Cancel scheduled occurrences" variant={action === 'cancel' ? 'primary' : 'secondary'} disabled={disabled} onPress={() => setAction('cancel')} />
        {series.filter(item => item.status !== 'scheduled').map(item => <Text key={item.id} style={typography.muted}>{formatUkDate(item.date)} · {item.time} · {item.status} — unchanged</Text>)}
      </>}
      {(mode === 'create' || action === 'edit') && <>
        <SeriesField label="Series training time (HH:MM)" value={draft.time} disabled={disabled} onChange={time => setDraft(previous => ({ ...previous, time }))} />
        <SeriesField label="Series training venue" value={draft.venue} disabled={disabled} onChange={venue => setDraft(previous => ({ ...previous, venue }))} />
        <Text style={typography.section}>Expected players</Text>
        {players.map(player => player.active ? <View key={player.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Text style={[typography.body, { flex: 1 }]}>{player.displayName}</Text><Switch accessibilityLabel={`Series expects ${player.displayName}`} value={draft.expectedProfileIds.includes(player.id)} disabled={disabled} onValueChange={selected => setDraft(previous => ({ ...previous, expectedProfileIds: selected ? [...previous.expectedProfileIds, player.id] : previous.expectedProfileIds.filter(id => id !== player.id) }))} /></View> : <Card key={player.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><Text style={typography.body}>{player.displayName}</Text><Pill>Archived</Pill></View>
          {draft.expectedProfileIds.includes(player.id) ? <>
            <Text style={typography.muted}>Still expected in the scheduled occurrences. Remove this archived player before reviewing future changes.</Text>
            <Button label={`Remove ${player.displayName} from series expected players`} variant="secondary" disabled={disabled} onPress={() => setDraft(previous => ({ ...previous, expectedProfileIds: previous.expectedProfileIds.filter(id => id !== player.id) }))} />
          </> : <Text style={typography.muted}>Removed from the series draft. Held and cancelled occurrences stay unchanged.</Text>}
        </Card>)}
      </>}
      <Notice>Held and cancelled occurrences are retained unchanged. To move one date, use Edit this occurrence. Cancelling one occurrence never cancels its series.</Notice>
      <Button testID="training-series-review" label="Review training occurrences" disabled={disabled || sourceChanged || mode === 'manage' && scheduled.length === 0} onPress={review} />
    </>}
    <Button label="Keep saved training records" variant="quiet" disabled={disabled} onPress={onClose} />
  </View>;
}

function SeriesField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <View style={{ gap: 6 }}><Text style={typography.body}>{label}</Text><TextInput accessibilityLabel={label} value={value} editable={!disabled} autoCapitalize="none" onChangeText={onChange} style={{ borderWidth: 1, borderColor: '#627169', borderRadius: 10, padding: 12, minHeight: 48, fontSize: 16 }} /></View>;
}
