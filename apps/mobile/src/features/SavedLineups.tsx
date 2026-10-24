import { useState } from 'react';
import { Switch, Text, TextInput, View } from 'react-native';
import type { Allocation } from '@longball/domain';
import { autoFillLineup } from '@longball/application/lineup-autofill';
import { latestLineupTemplates, previewLineupTemplate, saveLineupTemplate, type SavedLineupTemplate } from '@longball/application/lineup-templates';
import { goalkeeperChoice, type PreparationCommand, type PreparationFixture, type PreparationState } from '@longball/application/preparation';
import { activePositionCodes } from '@longball/application/position-catalogue';
import { retainedPreparationPlayers } from '@longball/application/preparation-presentation';
import { randomUUID } from '../platform/id';
import { Button, Card, Notice, Pill, typography } from '../ui';

interface SetupEditor {
  templateId: string; expectedTemplateVersion: number; sourceRevision: number;
  name: string; formationId: string; selectedPlayerIds: string[]; allocations: Allocation[]; step: number;
}
export interface SavedLineupsProps {
  state: PreparationState;
  busy: boolean;
  onCommand: (command: PreparationCommand) => Promise<boolean>;
  fixture?: PreparationFixture;
  onApplied?: (formationId: string) => void;
}
/** Three simple team setups, independent of fixture creation and advanced match policy. */
export function SavedLineups({ state, busy, onCommand, fixture, onApplied }: SavedLineupsProps) {
  const [editor, setEditor] = useState<SetupEditor | null>(null), [slotId, setSlotId] = useState<string | null>(null);
  const [review, setReview] = useState<ReturnType<typeof previewLineupTemplate> | null>(null);
  const [archive, setArchive] = useState<{ template: SavedLineupTemplate; sourceRevision: number } | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const templates = latestLineupTemplates(state), activeCodes = new Set(activePositionCodes(state));
  const formations = state.formations.filter(item => item.slots.every(slot => activeCodes.has(slot.position)));
  const players = state.profiles.filter(profile => profile.active && profile.seasonId === state.activeSeasonId);
  const editorPlayers = retainedPreparationPlayers(state, state.activeSeasonId, state.profiles.filter(profile => editor?.selectedPlayerIds.includes(profile.playerId)).map(profile => profile.id));
  const formation = formations.find(item => item.id === editor?.formationId);
  const stale = editor !== null && editor.sourceRevision !== state.revision;
  const label = (playerId: string) => state.profiles.find(profile => profile.playerId === playerId && profile.seasonId === state.activeSeasonId)?.displayName ?? 'Player unavailable';
  const open = (template?: SavedLineupTemplate) => {
    const preferred = formations.find(item => item.id === template?.formation.id) ?? formations.find(item => item.format === state.team.defaultPitchPlaces) ?? formations[0];
    setEditor({ templateId: template?.id ?? randomUUID(), expectedTemplateVersion: template?.version ?? 0, sourceRevision: state.revision, name: template?.name ?? '', formationId: preferred?.id ?? '', selectedPlayerIds: template ? [...template.selectedPlayerIds] : players.map(profile => profile.playerId), allocations: template ? template.allocations.map(row => ({ ...row })) : [], step: 0 });
    setSlotId(null); setError(null); setNotice(null); setReview(null); setArchive(null);
  };
  const change = (patch: Partial<SetupEditor>) => { setEditor(previous => previous ? { ...previous, ...patch } : null); setError(null); };
  const input = editor ? { templateId: editor.templateId, expectedTemplateVersion: editor.expectedTemplateVersion, name: editor.name, formationId: editor.formationId, selectedPlayerIds: editor.selectedPlayerIds, allocations: editor.allocations } : null;
  const run = async (command: PreparationCommand, success: string) => {
    setError(null);
    try { if (await onCommand(command)) { setNotice(success); setEditor(null); setReview(null); setArchive(null); return true; } }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'This setup was not saved. Your draft is retained.'); }
    return false;
  };
  const suggest = () => {
    if (!editor || !formation || stale) return;
    const result = autoFillLineup({ slots: formation.slots.map(slot => ({ slotId: slot.id, position: slot.position })), players: players.filter(profile => editor.selectedPlayerIds.includes(profile.playerId)).map(profile => ({ id: profile.playerId, preferences: profile.preferences, eligiblePositions: profile.eligiblePositions, goalkeeperChoice: goalkeeperChoice(profile), available: true })) });
    if (result.status === 'infeasible') setError(result.reason);
    else { change({ allocations: result.allocations }); setNotice('Suggested positions are a draft. Review every place before saving this setup.'); }
  };
  const next = () => {
    if (!editor || stale) return;
    try {
      if (editor.step === 0 && (!editor.name.trim() || !formation)) throw new Error('Name this setup and choose a saved formation.');
      if (editor.step === 1 && (!formation || editor.selectedPlayerIds.length < formation.format)) throw new Error('Choose enough squad players for every pitch place.');
      if (editor.step === 1 && editor.selectedPlayerIds.some(playerId => !players.some(profile => profile.playerId === playerId))) throw new Error('Remove archived or unavailable players from this setup draft before continuing. Earlier saved copies stay unchanged.');
      if (editor.step === 2 && input) saveLineupTemplate(state, input);
      change({ step: editor.step + 1 });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review the setup before continuing.'); }
  };
  return <Card><View style={{ gap: 14 }} testID="saved-lineups">
    <Text style={typography.section}>Saved player setups</Text>
    <Text style={typography.muted}>Keep up to three named setups for this team and season. Build them before match day, then review a copy for a fixture. Saved setups do not mark attendance, change replies or start play.</Text>
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    {editor ? <>
      <Text accessibilityRole="header" style={typography.section}>Step {editor.step + 1} of 4 · {['Setup details', 'Choose squad', 'Assign positions', 'Review setup'][editor.step]}</Text>
      {stale && <Notice tone="warning">Saved preparation changed while this setup was open. Your draft is retained. Close it and reopen the latest saved values before saving; no old fields are silently rebased.</Notice>}
      {editor.step === 0 && <>
        <Text style={typography.label}>Setup name</Text><TextInput accessibilityLabel="Saved setup name" value={editor.name} onChangeText={name => change({ name })} maxLength={60} editable={!busy} style={{ borderWidth: 1, borderColor: '#526459', borderRadius: 8, padding: 12, minHeight: 48, fontSize: 16 }} />
        <Text style={typography.label}>Formation</Text>
        {formations.map(item => <Button key={item.id} label={`${item.name} · ${item.format} places`} variant={formation?.id === item.id ? 'primary' : 'secondary'} disabled={busy || stale} onPress={() => { change({ formationId: item.id, allocations: [] }); setSlotId(null); }} />)}
        {formations.length === 0 && <Notice tone="warning">Create a formation using active team positions first.</Notice>}
      </>}
      {editor.step === 1 && <>
        <Text style={typography.body}>{editor.selectedPlayerIds.length} squad players selected. Those without a pitch place remain on the proposed bench.</Text>
        {editorPlayers.map(profile => profile.active ? <View key={profile.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}><Switch accessibilityLabel={`Setup selects ${profile.displayName}`} value={editor.selectedPlayerIds.includes(profile.playerId)} disabled={busy || stale} onValueChange={selected => change({ selectedPlayerIds: selected ? [...editor.selectedPlayerIds, profile.playerId] : editor.selectedPlayerIds.filter(id => id !== profile.playerId), allocations: selected ? editor.allocations : editor.allocations.filter(row => row.playerId !== profile.playerId) })} /><Text style={[typography.body, { flex: 1 }]}>{profile.displayName}</Text></View> : <Card key={profile.id}><Text style={typography.body}>{profile.displayName}</Text><Pill>Archived</Pill><Text style={typography.muted}>Still selected in this saved setup. Remove this player from the new draft; previous versions and recorded matches retain their copies.</Text><Button label={`Remove ${profile.displayName} from setup squad`} variant="secondary" disabled={busy || stale} onPress={() => change({ selectedPlayerIds: editor.selectedPlayerIds.filter(id => id !== profile.playerId), allocations: editor.allocations.filter(row => row.playerId !== profile.playerId) })} /></Card>)}
      </>}
      {editor.step === 2 && formation && <>
        <Notice>Use the selected planning squad. Actual match attendance is still recorded separately. Suggestions favor ranked positions within approved eligibility.</Notice>
        <Button label="Suggest best positions for this squad" disabled={busy || stale} onPress={suggest} testID="saved-lineup-auto-fill" />
        {formation.slots.map(slot => <Button key={slot.id} label={`${slot.label} · ${editor.allocations.find(row => row.slotId === slot.id) ? label(editor.allocations.find(row => row.slotId === slot.id)!.playerId) : 'Choose player'}`} variant={slotId === slot.id ? 'primary' : 'secondary'} disabled={busy || stale} onPress={() => setSlotId(slot.id)} />)}
        {slotId && <>
          <Text style={typography.label}>Choose a player for {formation.slots.find(slot => slot.id === slotId)?.label}</Text>
          {players.filter(profile => { const slot = formation.slots.find(item => item.id === slotId)!; return editor.selectedPlayerIds.includes(profile.playerId) && profile.eligiblePositions.includes(slot.position) && (slot.position !== 'GK' || goalkeeperChoice(profile) > 0); }).map(profile => <Button key={profile.id} label={`Assign ${profile.displayName}`} variant="secondary" disabled={busy || stale} onPress={() => { const slot = formation.slots.find(item => item.id === slotId)!; change({ allocations: [...editor.allocations.filter(row => row.slotId !== slotId && row.playerId !== profile.playerId), { slotId, position: slot.position, playerId: profile.playerId }] }); setSlotId(null); }} />)}
        </>}
      </>}
      {editor.step === 3 && <>
        <Text style={typography.body}>{editor.name} · {formation?.name} · {editor.selectedPlayerIds.length} in the squad</Text>
        {formation?.slots.map(slot => <Text key={slot.id} style={typography.body}>{slot.label}: {label(editor.allocations.find(row => row.slotId === slot.id)?.playerId ?? '')}</Text>)}
        <Text style={typography.muted}>Proposed bench: {editor.selectedPlayerIds.filter(id => !editor.allocations.some(row => row.playerId === id)).map(label).join(', ') || 'None'}</Text>
        <Button label="Save player setup" disabled={busy || stale} testID="saved-lineup-confirm" onPress={() => { if (input) { try { saveLineupTemplate(state, input); void run({ type: 'lineup_template.saved', ...input, id: randomUUID(), expectedRevision: editor.sourceRevision }, 'Player setup saved.'); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review this setup.'); } } }} />
      </>}
      {editor.step < 3 && <Button label="Continue setup" disabled={busy || stale} onPress={next} testID="saved-lineup-next" />}
      {editor.step > 0 && <Button label="Back one setup step" variant="secondary" disabled={busy} onPress={() => change({ step: editor.step - 1 })} />}
      <Button label={stale ? 'Discard setup draft and close' : 'Keep saved setups; close draft'} variant="quiet" onPress={() => { setEditor(null); setError(null); }} />
    </> : <>
      <Pill>{templates.length} of 3 saved</Pill>
      <Button label="Create player setup" variant="secondary" disabled={busy || templates.length >= 3 || formations.length === 0} onPress={() => open()} testID="saved-lineup-create" />
      {templates.length === 3 && <Text style={typography.muted}>Edit a saved setup or archive one to free a place.</Text>}
      {templates.map(template => <Card key={template.id}>
        <Text style={typography.section}>{template.name}</Text><Text style={typography.muted}>{template.formation.format} places · {template.selectedPlayerIds.length} squad players · version {template.version}</Text>
        <Button label={`Edit setup ${template.name}`} variant="secondary" disabled={busy} onPress={() => open(template)} />
        {fixture && <Button label={`Review setup ${template.name} for this fixture`} variant="secondary" disabled={busy} onPress={() => { setReview(previewLineupTemplate(state, template.id, fixture.id)); setError(null); setArchive(null); }} />}
        <Button label={`Archive setup ${template.name}`} variant="quiet" disabled={busy} onPress={() => { setArchive({ template, sourceRevision: state.revision }); setReview(null); }} />
      </Card>)}
      {archive && <>
        <Notice>Archive {archive.template.name}? Existing fixture drafts and recorded matches keep their saved copies.</Notice>
        <Button label="Confirm archive setup" disabled={busy || archive.sourceRevision !== state.revision} onPress={() => { void run({ type: 'lineup_template.archived', templateId: archive.template.id, expectedTemplateVersion: archive.template.version, id: randomUUID(), expectedRevision: archive.sourceRevision }, 'Setup archived. Saved match history is unchanged.'); }} />
        <Button label="Keep this setup" variant="quiet" onPress={() => setArchive(null)} />
      </>}
      {review && <>
        <Notice tone={review.ready ? 'info' : 'warning'}>{review.ready ? 'Review this squad and starting positions. Confirming copies a draft to the fixture; replies, actual check-in and accepted match history stay unchanged.' : review.blockers.join(' ')}</Notice>
        {review.template && <Text style={typography.body}>{review.template.name} → {fixture?.opponent ?? 'Selected fixture'} · {review.template.selectedPlayerIds.length} selected</Text>}
        {review.warnings.map(warning => <Text key={warning} style={typography.muted}>{warning}</Text>)}
        {review.template?.allocations.map(row => <Text key={row.slotId} style={typography.body}>{row.position}: {label(row.playerId)}</Text>)}
        {review.template && <Text style={typography.muted}>Proposed bench: {review.template.selectedPlayerIds.filter(id => !review.template!.allocations.some(row => row.playerId === id)).map(label).join(', ') || 'None'}</Text>}
        {review.sourceRevision !== state.revision && <Notice tone="warning">Preparation changed. Close this preview and review the setup again.</Notice>}
        <Button label="Apply setup as fixture draft" testID="saved-lineup-apply" disabled={busy || !review.ready || review.sourceRevision !== state.revision} onPress={() => { const template = review.template; if (template) void run({ type: 'lineup_template.applied', templateId: template.id, templateVersion: template.version, fixtureId: review.fixtureId, previewKey: review.previewKey, confirm: true, id: randomUUID(), expectedRevision: review.sourceRevision }, 'Setup copied to this fixture as a draft.').then(saved => { if (saved) onApplied?.(`lineup-template:${template.id}:${template.version}`); }); }} />
        <Button label="Close setup preview" variant="quiet" onPress={() => setReview(null)} />
      </>}
      {fixture?.lineupTemplateDraft && <Button label="Clear this fixture setup draft" variant="quiet" disabled={busy} onPress={() => { void run({ type: 'lineup_template.cleared', fixtureId: fixture.id, id: randomUUID(), expectedRevision: state.revision }, 'Fixture setup draft cleared. Saved team setups and match history are unchanged.'); }} />}
    </>}
  </View></Card>;
}
