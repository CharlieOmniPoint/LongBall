import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { playerMinutes, readClock as deriveClock, rationalToNumber, type Allocation, type ClockReading, type ClockSample, type MatchState } from '@longball/domain';
import { planMatch, selectMatchPositionMode, updatePlanAlerts, type FutureSegment, type PastTargetSegment, type PlanAlertState, type PlannerInput, type PlannerResult, type PlannerSettings } from '@longball/domain/planner';
import { getAlertCapability, replaceLocalWarnings, requestAlertPermission } from '../platform/alerts';
import { Button, Card, Notice, Pill } from '../ui/Button';
import { colors, typography } from '../ui/tokens';

export interface ConfirmedPlannerSettings {
  batchPreference: number;
  leadThreshold: number;
  returnToNormal: boolean;
}

/** Builds a projection from frozen game snapshots; no availability or recorded time is invented. */
export function plannerInputFromMatch(match: MatchState, sample: ClockSample, accepted: ConfirmedPlannerSettings, planVersion: number, mode: 'normal' | 'adventurous'): PlannerInput {
  const clock = deriveClock(match, sample);
  if (clock.recoveryRequired) throw new Error('Time needs checking before planning.');
  const snapshots = match.config.profileSnapshot;
  if (!snapshots?.length || !match.config.slots?.length) throw new Error('Review and save the formation and player eligibility in Preparation before planning.');
  const players = match.config.players.filter(player => match.config.selectedPlayerIds.includes(player.id)).map(player => {
    const profile = snapshots.find(item => item.playerId === player.id);
    if (!profile) throw new Error(`Saved eligibility is missing for ${player.displayName}; review Preparation.`);
    const rank = profile.preferences.indexOf('GK');
    return { id: player.id, goalkeeperChoice: rank === 0 || rank === 1 ? rank + 1 : 0, eligiblePositions: [...profile.eligiblePositions], preferences: [...profile.preferences] };
  });
  const keeperIdsFor = (availableIds: string[]) => players.filter(player => availableIds.includes(player.id) && (player.goalkeeperChoice === 1 || player.goalkeeperChoice === 2) && player.eligiblePositions.includes('GK')).map(player => player.id);
  const present = match.config.selectedPlayerIds.filter(id => match.attendance[id] === 'present' && match.availability[id]);
  const fixed = match.config.fixedKeeperId;
  const keepers = keeperIdsFor(present);
  const goalkeeperPolicy: FutureSegment['goalkeeperPolicy'] = fixed ? { kind: 'fixed', playerId: fixed } : { kind: 'shared', eligibleKeeperIds: keepers };
  const history: PastTargetSegment[] = match.targetIntervals.map(interval => ({ ...interval, availablePlayerIds: [...interval.availablePlayerIds], keeperIds: interval.fixedKeeperId ? [interval.fixedKeeperId] : keeperIdsFor(interval.availablePlayerIds) }));
  const checkpointGap = clock.matchActiveMs - match.matchActiveMs;
  if (checkpointGap > 0) history.push({ durationMs: checkpointGap, availablePlayerIds: present, fixedKeeperId: fixed && present.includes(fixed) ? fixed : null, pitchPlaces: match.config.pitchPlaces, keeperIds: fixed && present.includes(fixed) ? [fixed] : keeperIdsFor(present) });
  const actual = Object.fromEntries(playerMinutes(match, sample).map(player => [player.playerId, { playingMs: player.playingMs, goalkeeperMs: player.positionMs.GK ?? 0 }]));
  const halfMs = match.config.plannedHalfDurationMs;
  const now = clock.matchActiveMs;
  const segments: FutureSegment[] = [];
  const append = (startMs: number, endMs: number, half: 1 | 2, halfStartMs: number) => {
    if (endMs > startMs) segments.push({ startMs, endMs, half, halfStartMs, plannedHalfMs: halfMs, availablePlayerIds: present, goalkeeperPolicy, availabilityBasis: 'confirmed', underStrengthApproval: null });
  };
  if (match.status === 'preparation') { append(0, halfMs, 1, 0); append(halfMs, halfMs * 2, 2, halfMs); }
  else if (match.status === 'half_time') append(now, now + halfMs, 2, now);
  else if (match.half === 1 && (match.status === 'first_half_running' || match.status === 'first_half_paused')) {
    const secondStart = now + Math.max(0, halfMs - clock.halfActiveMs);
    append(now, secondStart, 1, 0); append(secondStart, secondStart + halfMs, 2, secondStart);
  } else if (match.half === 2 && (match.status === 'second_half_running' || match.status === 'second_half_paused')) append(now, now + Math.max(0, halfMs - clock.halfActiveMs), 2, match.firstHalfDurationMs ?? now - clock.halfActiveMs);
  const currentLineup = match.status === 'preparation' || match.status === 'half_time' ? match.stagedLineup : match.lineup;
  const spells: Record<string, number> = {};
  for (const allocation of currentLineup) {
    let boundary = match.matchActiveMs;
    const intervals = match.intervals.filter(interval => interval.playerId === allocation.playerId).sort((left, right) => right.endMs - left.endMs);
    for (const interval of intervals) { if (interval.endMs !== boundary || interval.state !== 'playing') break; boundary = interval.startMs; }
    spells[allocation.playerId] = match.status === 'preparation' ? 0 : match.lineup.some(item => item.playerId === allocation.playerId) ? boundary : now;
  }
  const settings: PlannerSettings = {
    policyStatus: 'synthetic_experiment', preferredMinSpellMs: 300_000, preferredBufferFraction: 0.15, preferredBatchSize: accepted.batchPreference,
    hardMinSpellMs: null, hardBufferFraction: null, hardBatchCap: null, hardSubstitutionGridMs: null,
    normalPositionCosts: [0, 1, 4, 8], adventurousPositionCosts: [1, 0, 0.5, 8], positionMode: mode, maxWork: 500_000,
  };
  return { planId: `${match.config.matchId}-suggestion`, planVersion, sourceRevision: match.revision, seed: `${match.config.matchId}-rotation`, nowMs: now, players, slots: match.config.slots.map(slot => ({ slotId: slot.slotId, position: slot.position })), currentLineup: currentLineup.map(item => ({ ...item })), currentSpellStartedMs: spells, actual, pastTargetSegments: history, futureSegments: segments, locks: [], settings };
}

export function usePlannerModel(match: MatchState | null, sample: ClockSample, clock: ClockReading | null, context: { hasControl?: boolean; alertOwner?: string } = {}) {
  const [batchPreference, setBatchPreference] = useState(2);
  const [threshold, setThreshold] = useState('4');
  const [returnToNormal, setReturnToNormal] = useState<boolean | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedPlannerSettings | null>(null);
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [result, setResult] = useState<PlannerResult | null>(null);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [alertCapability, setAlertCapability] = useState<string | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);
  const [lastWarning, setLastWarning] = useState<string | null>(null);
  const [permissionVersion, setPermissionVersion] = useState(0);
  const [requestedControl, setHasControl] = useState(true);
  const hasControl = requestedControl && context.hasControl !== false;
  const alertOwner = context.alertOwner ?? `local-planner-${match?.config.matchId ?? 'none'}`;
  const sampleRef = useRef(sample);
  const clockRef = useRef(clock);
  const planVersion = useRef(0);
  const modeRef = useRef<{ matchId: string | null; mode: 'normal' | 'adventurous' }>({ matchId: null, mode: 'normal' });
  const alertState = useRef<PlanAlertState | null>(null);
  const previousStatus = useRef(match?.status);

  useEffect(() => { sampleRef.current = sample; clockRef.current = clock; }, [sample, clock]);
  useEffect(() => { let active = true; void getAlertCapability().then(value => { if (active) setAlertCapability(value); }).catch(error => { if (active) setAlertError(error instanceof Error ? error.message : 'Notification capability could not be checked.'); }); return () => { active = false; }; }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (!match || !confirmed || confirmedFor !== match.config.matchId || !hasControl || clockRef.current?.recoveryRequired || match.status === 'completed' || match.status === 'abandoned') { setResult(null); setPlanning(false); return; }
      setPlanning(true);
      setPlanningError(null);
      modeRef.current = selectMatchPositionMode(modeRef.current, { matchId: match.config.matchId, ourScore: match.score.for, oppositionScore: match.score.against, leadThreshold: confirmed.leadThreshold, returnToNormal: confirmed.returnToNormal, manualReset: false });
      try {
        const input = plannerInputFromMatch(match, sampleRef.current, confirmed, ++planVersion.current, modeRef.current.mode);
        const planned = planMatch(input);
        if (active) { setResult(planned); setPlanning(false); }
      } catch (error) { if (active) { setResult(null); setPlanning(false); setPlanningError(error instanceof Error ? error.message : 'Planning could not be completed.'); } }
    });
    return () => { active = false; };
    // sample/clock render ticks are deliberately read from refs; they never run the solver.
  }, [match, confirmed, confirmedFor, requestVersion, hasControl]);

  const currentMatchId = match?.config.matchId;
  const currentResult = result?.planId === `${currentMatchId}-suggestion` ? result : null;
  const currentConfirmed = confirmedFor === currentMatchId ? confirmed : null;
  const matchStatus = match?.status;
  const currentHalf = match?.half;
  const revision = match?.revision;
  const recoveryRequired = clock?.recoveryRequired ?? true;
  useEffect(() => {
    const next = currentResult?.status === 'feasible' ? currentResult.nextChange : null;
    const running = Boolean(next && next.half === currentHalf && matchStatus?.endsWith('_running') && hasControl && !recoveryRequired && currentResult?.sourceRevision === revision);
    const reminderRevision = currentResult ? `${currentResult.planId}-${currentResult.planVersion}-${currentResult.sourceRevision}` : 'no-current-plan';
    let active = true;
    void replaceLocalWarnings({ owner: alertOwner, revision: reminderRevision, dueInMs: next ? next.dueMatchActiveMs - (clockRef.current?.matchActiveMs ?? 0) : 0, running }).catch(error => { if (active) setAlertError(error instanceof Error ? error.message : 'Local reminders could not be scheduled. Use the visual countdown.'); });
    return () => { active = false; void replaceLocalWarnings({ owner: alertOwner, revision: `${reminderRevision}-cancel`, dueInMs: 0, running: false }).catch(() => {}); };
  }, [currentResult, matchStatus, currentHalf, revision, hasControl, recoveryRequired, permissionVersion, alertOwner]);

  useEffect(() => {
    const next = currentResult?.status === 'feasible' ? currentResult.nextChange : null;
    const status = matchStatus?.endsWith('_running') ? 'running' : matchStatus === 'half_time' ? 'half_time' : matchStatus === 'completed' || matchStatus === 'abandoned' ? 'terminal' : 'paused';
    const resuming = previousStatus.current?.endsWith('_paused') === true && status === 'running';
    previousStatus.current = matchStatus;
    const update = updatePlanAlerts({ plan: next && currentResult && (status !== 'running' || next.half === currentHalf) ? { planId: currentResult.planId, planVersion: currentResult.planVersion, sourceRevision: currentResult.sourceRevision, dueMatchActiveMs: next.dueMatchActiveMs } : null, activeMs: clock?.matchActiveMs ?? 0, sourceRevision: revision ?? 0, status, hasControl, timeCertain: !recoveryRequired, resuming, previous: alertState.current });
    alertState.current = update.state;
    if (update.fireNow.length) {
      const thresholdSeconds = update.fireNow[0];
      void Promise.resolve().then(() => setLastWarning(thresholdSeconds === 0 ? 'Change due — review and confirm the actual lineup.' : `Planned change in ${thresholdSeconds} seconds.`));
    } else if (update.cancelPrevious) void Promise.resolve().then(() => setLastWarning(null));
  }, [currentResult, clock, matchStatus, currentHalf, revision, hasControl, recoveryRequired]);

  const confirmSettings = useCallback(() => {
    const leadThreshold = Number(threshold);
    if (!Number.isInteger(leadThreshold) || leadThreshold <= 0 || !Number.isInteger(batchPreference) || batchPreference < 1 || batchPreference > 11 || returnToNormal === null) { setSettingsError('Choose a positive whole-number lead threshold, a batch preference and an explicit return-to-normal option.'); return; }
    if (!currentMatchId) { setSettingsError('Open a match before confirming its settings.'); return; }
    setConfirmed({ batchPreference, leadThreshold, returnToNormal }); setConfirmedFor(currentMatchId); setSettingsError(null);
  }, [threshold, batchPreference, returnToNormal, currentMatchId]);
  const requestNotifications = useCallback(async () => {
    try { setAlertCapability(await requestAlertPermission()); setAlertError(null); setPermissionVersion(value => value + 1); }
    catch (error) { setAlertError(error instanceof Error ? error.message : 'Permission request failed. Keep the visual console open.'); }
  }, []);
  const nextChange = currentResult?.status === 'feasible' && currentResult.sourceRevision === revision ? currentResult.nextChange : null;
  const awaitingHalfTime = Boolean(nextChange?.half === 2 && currentHalf === 1 && matchStatus !== 'half_time');
  return { match, awaitingHalfTime, batchPreference, setBatchPreference, threshold, setThreshold, returnToNormal, setReturnToNormal, confirmed: currentConfirmed, confirmSettings, settingsError, result: currentResult, planningError, planning, replan: () => setRequestVersion(value => value + 1), nextChange, dueInMs: nextChange ? nextChange.dueMatchActiveMs - (clock?.matchActiveMs ?? 0) : null, alertCapability, alertError, lastWarning, requestNotifications, hasControl, setHasControl, timeCertain: !recoveryRequired };
}
export type PlannerModel = ReturnType<typeof usePlannerModel>;

function duration(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
export function PlannerPanel({ model, onReviewLineup }: { model: PlannerModel; onReviewLineup: (lineup: Allocation[], sourceRevision: number) => void }) {
  const [editing, setEditing] = useState(false);
  const label = (id: string) => model.match?.config.players.find(player => player.id === id)?.displayName ?? id;
  const next = model.nextChange;
  return <View style={styles.stack}>
    <Card>
      <View style={styles.heading}><Text style={typography.section}>Playing-time plan</Text><Pill tone="muted">MANAGER SUGGESTION</Pill></View>
      <Text style={typography.body}>Fair time, with every change confirmed by you.</Text>
      {!model.confirmed || editing ? <View style={styles.stack}>
        <Notice tone="info">Roma’s five-minute playing spells and 15% half buffers are flexible preferences. Choose and confirm the other settings before planning.</Notice>
        <Text style={typography.label}>Preferred batch size · proposed starting value 2</Text>
        <View style={styles.row}>
          <Button label="−" variant="secondary" disabled={model.batchPreference <= 1} onPress={() => model.setBatchPreference(Math.max(1, model.batchPreference - 1))} />
          <Text style={styles.settingNumber}>{model.batchPreference}</Text>
          <Button label="+" variant="secondary" disabled={model.batchPreference >= 11} onPress={() => model.setBatchPreference(Math.min(11, model.batchPreference + 1))} />
        </View>
        <Text style={typography.muted}>This is a preference, with no hard batch cap or mandatory five-minute grid.</Text>
        <Text style={typography.label}>Score lead for adventurous positions</Text>
        <TextInput accessibilityLabel="Score lead threshold" keyboardType="number-pad" value={model.threshold} onChangeText={model.setThreshold} style={styles.input} />
        <Text style={typography.label}>Return to normal when the lead falls?</Text>
        <View style={styles.row}>
          <Button label={model.returnToNormal === true ? 'Yes · selected' : 'Yes'} variant={model.returnToNormal === true ? 'primary' : 'secondary'} onPress={() => model.setReturnToNormal(true)} />
          <Button label={model.returnToNormal === false ? 'No · selected' : 'No'} variant={model.returnToNormal === false ? 'primary' : 'secondary'} onPress={() => model.setReturnToNormal(false)} />
        </View>
        <Text style={typography.muted}>Position weights and Q07 availability/keeper transitions are labelled synthetic experiments. Confirming these review settings does not approve unresolved product policy.</Text>
        {model.settingsError && <Notice tone="error">{model.settingsError}</Notice>}
        <Button label="Confirm settings and plan" onPress={() => { model.confirmSettings(); if (model.returnToNormal !== null && Number.isInteger(Number(model.threshold)) && Number(model.threshold) > 0) setEditing(false); }} />
      </View> : <View style={styles.stack}>
        <Text style={typography.muted}>Preferred batch {model.confirmed.batchPreference} · lead {model.confirmed.leadThreshold} · return to normal {model.confirmed.returnToNormal ? 'on' : 'off'}. Settings are held for this review session.</Text>
        <Button label="Review settings" variant="quiet" onPress={() => setEditing(true)} />
      </View>}
    </Card>
    {model.planningError && <Notice tone="warning">{model.planningError}</Notice>}
    {model.planning && <Notice>Preparing a deterministic suggestion…</Notice>}
    {model.result && <Card>
      <Pill tone={model.result.status === 'feasible' ? 'brand' : 'warning'}>{model.result.status === 'feasible' ? 'Validated projection' : model.result.status === 'infeasible' ? 'Constraint conflict' : 'Planning incomplete'}</Pill>
      <Text style={typography.body}>{model.result.explanations[0]}</Text>
      <Text style={typography.muted}>Projection assumes current availability continues. Actual time is never rewritten to improve fairness.</Text>
      {model.result.status === 'feasible' && next ? <View style={styles.stack}>
        <Text style={typography.label}>{model.awaitingHalfTime ? 'At half-time, after the manual end of the first half' : model.dueInMs !== null && model.dueInMs <= 0 ? `Change overdue by ${duration(-model.dueInMs)}` : `Next change in ${duration(model.dueInMs ?? 0)}`}</Text>
        <Text style={typography.body}>{next.outgoingPlayerIds.length ? `Off: ${next.outgoingPlayerIds.map(label).join(', ')}` : 'Review the proposed positions.'}</Text>
        {next.incomingPlayerIds.length > 0 && <Text style={typography.body}>On: {next.incomingPlayerIds.map(label).join(', ')}</Text>}
        {next.exceptions.map(note => <Notice key={note} tone="warning">{note}</Notice>)}
        {model.lastWarning && <Notice tone="warning">{model.lastWarning}</Notice>}
        <Button label="Review suggested lineup" disabled={!model.timeCertain || !model.hasControl || model.awaitingHalfTime} onPress={() => onReviewLineup(next.lineup.map(item => ({ ...item })), model.result!.sourceRevision)} />
        <Text style={typography.muted}>The review opens a draft. Confirm only when the players actually change. Half-time edits commit on second-half Start.</Text>
      </View> : model.result.status === 'feasible' ? <Text style={typography.body}>No further change is required by this validated projection.</Text> : <Notice tone="warning">Keep the current confirmed lineup, review the explained constraint and replan. An incomplete search does not prove the targets impossible.</Notice>}
      <Button label="Replan from actual time" variant="secondary" disabled={model.planning || !model.timeCertain} onPress={model.replan} />
      <View style={styles.table}>
        <Text style={typography.label}>Projected total · individual target</Text>
        {model.result.players.map(player => <View key={player.playerId} style={styles.summaryRow}><Text style={typography.muted}>{label(player.playerId)}</Text><Text style={typography.label}>{duration(player.projectedMs)} · {duration(rationalToNumber(player.target))}{player.withinBand ? '' : ' · outside band'}</Text></View>)}
      </View>
      <Text style={typography.muted}>Each player’s band is 90–110% of their own target. Goalkeeper duties are checked separately; two keepers also need fair total playing time.</Text>
    </Card>}
    {model.confirmed && <Card>
      <Text style={typography.label}>Match reminders</Text>
      <Text style={typography.muted}>{model.alertCapability ?? 'Checking notification capability…'}</Text>
      {model.alertError && <Notice tone="warning">{model.alertError}</Notice>}
      <Button label="Enable local reminders" variant="secondary" onPress={() => { void model.requestNotifications(); }} />
      <Text style={typography.muted}>90/60/30/0-second reminders follow the current plan. Pause, half-time, recovery, replan and control loss cancel them. The visual countdown remains available. Phone lock, Focus, force-stop and battery behaviour require native device tests.</Text>
    </Card>}
  </View>;
}
const styles = StyleSheet.create({
  stack: { gap: 12 }, row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  heading: { gap: 8 }, settingNumber: { ...typography.section, minWidth: 32, textAlign: 'center' },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 8, paddingHorizontal: 14, color: colors.ink, fontSize: 18, backgroundColor: colors.surface },
  table: { gap: 8, borderTopWidth: 1, borderColor: colors.border, paddingTop: 12 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
});
