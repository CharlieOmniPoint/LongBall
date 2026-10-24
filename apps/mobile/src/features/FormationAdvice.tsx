import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { activePositionCodes, type PreparationCommand, type PreparationState } from '@longball/application/preparation';
import { recommendFormations } from '@longball/application/formation-advice';
import { Button, Card, Notice, Pill, typography } from '../ui';
import { FormationDiagram } from './FormationDesigner';
import { randomUUID } from '../platform/id';

export interface FormationAdviceProps {
  state: PreparationState;
  fixtureId: string;
  onChooseFormation?: (formationId: string) => void;
  onChange?: (command: PreparationCommand) => Promise<boolean> | boolean;
  disabled?: boolean;
}
export function FormationAdvice({ state, fixtureId, onChooseFormation, onChange, disabled = false }: FormationAdviceProps) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(0), [details, setDetails] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const fixture = state.fixtures.find(item => item.id === fixtureId);
  const model = useMemo(() => {
    if (!open || !fixture) return null;
    try {
      const selectedProfiles = state.profiles.filter(profile => profile.active && profile.seasonId === fixture.seasonId && fixture.selectedProfileIds.includes(profile.id));
      if (selectedProfiles.some(profile => !fixture.responses[profile.id] || ['no_reply', 'unsure'].includes(fixture.responses[profile.id]))) throw new Error('Set Available or Unavailable for every selected player first. You can record a reply on their behalf.');
      const profiles = selectedProfiles.filter(profile => fixture.responses[profile.id] === 'available' && fixture.attendance[profile.id] !== 'absent');
      const recommendations = recommendFormations({ profiles, format: fixture.format, formations: state.formations, activePositions: activePositionCodes(state) });
      if (!recommendations.length) throw new Error('No formation uses the current active team positions. Create a formation or review Team positions first.');
      return { recommendations, error: null };
    } catch (cause) { return { recommendations: [], error: cause instanceof Error ? cause.message : 'Formation advice could not be calculated.' }; }
  }, [open, fixture, state]);
  if (!fixture || fixture.status !== 'scheduled') return null;
  const recommendation = model?.recommendations[Math.min(selected, Math.max(0, model.recommendations.length - 1))];
  const choose = async () => {
    if (!recommendation || !recommendation.feasible || saving || disabled) return;
    setSaving(true); setError(null);
    try {
      const formation = recommendation.formation;
      if (formation.version === 0) {
        if (!onChange) throw new Error('Save this suggested formation in Formation before selecting it.');
        const { version: _version, ...draft } = formation;
        const saved = await onChange({ id: randomUUID(), expectedRevision: state.revision, type: 'formation.saved', formation: draft });
        if (!saved) return;
      }
      onChooseFormation?.(formation.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The formation was not selected.'); }
    finally { setSaving(false); }
  };
  return <Card testID="formation-advice">
    <Text style={typography.section}>Formation advice</Text>
    <Text style={typography.body}>Aim for 65% of each player’s time in their primary position and 35% in their secondary position.</Text>
    <Button label={open ? 'Hide formation advice' : 'Find the best formation'} testID="formation-advice-open" disabled={disabled || saving} variant="secondary" onPress={() => setOpen(value => !value)} />
    {model?.error && <Notice tone="warning">{model.error}</Notice>}
    {recommendation && <View style={styles.stack}>
      <View style={styles.row}>{model!.recommendations.slice(0, 4).map((item, index) => <Button key={item.formation.id} label={item.formation.name} compact variant={index === selected ? 'primary' : 'secondary'} disabled={saving} onPress={() => setSelected(index)} />)}</View>
      <Pill tone={recommendation.feasible ? 'brand' : 'warning'}>{recommendation.feasible ? `${Math.round(recommendation.targetFit * 100)}% of the desired position split covered` : 'Position cover needs review'}</Pill>
      <FormationDiagram formation={recommendation.formation} />
      {recommendation.notes.map(note => <Text key={note} style={typography.muted}>{note}</Text>)}
      <Button label={details ? 'Hide position breakdown' : 'View position breakdown'} compact variant="quiet" onPress={() => setDetails(value => !value)} />
      {details && recommendation.players.map(player => <View key={player.playerId} style={styles.summary}><Text style={typography.label}>{player.label}</Text><Text style={typography.muted}>{player.fixedGoalkeeper ? 'Goalkeeper · whole match' : `Primary ${Math.round(player.primary * 100)}% · Secondary ${Math.round(player.secondary * 100)}%${player.other > 0.005 ? ` · Other ${Math.round(player.other * 100)}%` : ''}`}{player.unallocatedShare > 0.0001 ? ' · incomplete cover' : ''}</Text></View>)}
      {error && <Notice tone="error">{error}</Notice>}
      {onChooseFormation && <Button label={saving ? 'Saving formation…' : recommendation.formation.version === 0 ? 'Save and choose this formation' : 'Choose this formation'} testID="formation-advice-choose" disabled={disabled || saving || !recommendation.feasible} onPress={() => { void choose(); }} />}
    </View>}
  </Card>;
}
const styles = StyleSheet.create({ stack: { gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, summary: { gap: 4 } });
