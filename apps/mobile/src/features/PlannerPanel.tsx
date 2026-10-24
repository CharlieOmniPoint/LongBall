import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, TextInput, View } from 'react-native';
import { rationalToNumber, type Allocation, type ClockReading, type ClockSample, type MatchState } from '@longball/domain';
import { planMatch, updatePlanAlerts, type PlanAlertState, type PlannerResult } from '@longball/domain/planner';
import { assertConfirmedPlannerSettings, assertPlannerPreferences, authorizePlannerPreferences, createPlannerPreferences, plannerPreferenceDocumentId, plannerPreferenceScope, type PlannerPreferenceBinding, type PlannerPreferences, type PlannerPreferenceScope } from '../platform/planner-preferences';
import { makePolicyChangeCommand, matchPlannerSettings, type PolicyChangeCommand, type ConfirmedMatchPlannerSettings } from '@longball/application/match-policy';
import { plannerInputFromMatch } from '@longball/application/match-planner';
import type { Journal } from '../platform/types';
import { useDocument } from '../useDocument';
import { getAlertCapability, replaceLocalWarnings, requestAlertPermission } from '../platform/alerts';
import { Button, Card, Notice, Pill } from '../ui/Button';
import { colors, typography } from '../ui/tokens';
import { DEFAULT_SUBSTITUTION_ALERTS, substitutionToneAtCheckpoint, type SubstitutionAlertSettings, type SubstitutionToneCheckpoint } from '@longball/application/substitution-alerts';
import { playSubstitutionAudio, prepareSubstitutionAudio, stopSubstitutionAudio, substitutionAudioCapability } from '../platform/substitution-audio';
import { SubstitutionCountdown, type SubstitutionCountdownSnapshot } from './SubstitutionCountdown';

export type ConfirmedPlannerSettings = ConfirmedMatchPlannerSettings;

export interface PlannerPolicyPort {
  commit: (command: PolicyChangeCommand) => Promise<boolean>;
  busy?: boolean;
  retryPending?: boolean;
  conflict?: boolean;
  retry?: () => Promise<boolean>;
  reload?: () => void;
  acceptedRevision?: number;
}

export interface PlannerPersistence {
  journal: Journal | null;
  deviceId: string | null;
  binding: PlannerPreferenceBinding;
}

function usePlannerPreferences(matchId: string | undefined, persistence: PlannerPersistence | undefined) {
  const journal = persistence?.journal ?? null;
  const deviceId = persistence?.deviceId ?? null;
  let scopeJson: string | null = null;
  let scopeError: string | null = null;
  try {
    if (matchId && deviceId && persistence) scopeJson = JSON.stringify(plannerPreferenceScope(matchId, deviceId, persistence.binding));
  } catch (error) { scopeError = error instanceof Error ? error.message : 'Planner settings scope is invalid.'; }
  const scope = useMemo(() => scopeJson ? JSON.parse(scopeJson) as PlannerPreferenceScope : null, [scopeJson]);
  const scopeRef = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  const documentId = scope ? plannerPreferenceDocumentId(scope) : 'planner-preferences-inactive';
  const [permission, setPermission] = useState<{ journal: Journal; documentId: string; allowed: boolean; error: string | null } | null>(null);
  useEffect(() => {
    if (!journal || !scope) return;
    let active = true;
    void authorizePlannerPreferences(journal, scope).then(() => {
      if (active) setPermission({ journal, documentId, allowed: true, error: null });
    }).catch(error => {
      if (active) setPermission({ journal, documentId, allowed: false, error: error instanceof Error ? error.message : 'Planner storage could not be checked.' });
    });
    return () => { active = false; };
  }, [journal, scope, documentId]);
  const permitted = permission?.journal === journal && permission.documentId === documentId && permission.allowed;
  const document = useDocument<PlannerPreferences>(permitted ? journal : null, deviceId, documentId,
    () => {
      if (!scopeRef.current) throw new Error('Select a match before opening planner settings.');
      return createPlannerPreferences(scopeRef.current);
    },
    value => {
      if (!scopeRef.current) throw new Error('Planner scope is unavailable. Existing settings were retained.');
      assertPlannerPreferences(value, scopeRef.current);
    });
  const error = scopeError ?? (permission?.journal === journal && permission.documentId === documentId ? permission.error : null) ?? document.error;
  return { ...document, ready: Boolean(permitted && document.state), permissionError: error, storageAvailable: Boolean(journal && scope) };
}

export { plannerInputFromMatch } from '@longball/application/match-planner';

export function usePlannerModel(match: MatchState | null, sample: ClockSample, clock: ClockReading | null, context: { hasControl?: boolean; alertOwner?: string; alertSettings?: SubstitutionAlertSettings; persistence?: PlannerPersistence; onRetainedChange?: (retained: boolean) => void; policy?: PlannerPolicyPort } = {}) {
  const [batchPreference, setBatchPreference] = useState(2);
  const [threshold, setThreshold] = useState('4');
  const [stintMinutes, setStintMinutes] = useState('5');
  const [bufferPercent, setBufferPercent] = useState('15');
  const [returnToNormal, setReturnToNormal] = useState<boolean | null>(null);
  const preferences = usePlannerPreferences(match?.config.matchId, context.persistence);
  const preferencesReady = preferences.ready && Boolean(context.policy);
  const preferenceRecord = preferences.state;
  const confirmed = useMemo(() => match ? matchPlannerSettings(match) : null, [match]);
  const confirmedFor = match?.activePolicy ? match.config.matchId : null;
  const proposed = match?.config.initialPolicyProposal?.payload;
  const legacyDraft = preferenceRecord?.settings;
  const [reason, setReason] = useState('');
  const [policySaving, setPolicySaving] = useState(false);
  const commitPolicy = context.policy?.commit;
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
  const alertState = useRef<PlanAlertState | null>(null);
  const previousStatus = useRef(match?.status);
  const toneState = useRef<SubstitutionToneCheckpoint | null>(null);
  const alertSettings = context.alertSettings ?? DEFAULT_SUBSTITUTION_ALERTS;
  const [audioReadyOwner, setAudioReadyOwner] = useState<string | null>(null);
  const audioReady = audioReadyOwner === alertOwner;
  const [audioMessage, setAudioMessage] = useState<string | null>(null);
  const [foreground, setForeground] = useState(() => (AppState.currentState == null || AppState.currentState === 'active') && (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
  useEffect(() => {
    const refresh = () => { const active = (AppState.currentState == null || AppState.currentState === 'active') && (typeof document === 'undefined' || document.visibilityState !== 'hidden'); setForeground(active); if (!active) stopSubstitutionAudio(alertOwner); };
    const native = AppState.addEventListener('change', refresh);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);
    return () => { native.remove(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh); stopSubstitutionAudio(alertOwner); };
  }, [alertOwner]);
  useEffect(() => { toneState.current = null; stopSubstitutionAudio(alertOwner); }, [alertOwner]);

  useEffect(() => { sampleRef.current = sample; clockRef.current = clock; }, [sample, clock]);
  const preferencesRetained = preferences.busy || preferences.retryPending || preferences.conflict || policySaving || Boolean(context.policy?.busy || context.policy?.retryPending || context.policy?.conflict);
  // A new event anchor can briefly be newer than the parent's last render sample.
  // Re-open planning when the next sample restores certainty, without solving on every tick.
  const recoveryRequired = clock?.recoveryRequired ?? true;
  const onRetainedChange = context.onRetainedChange;
  useEffect(() => { onRetainedChange?.(preferencesRetained); }, [onRetainedChange, preferencesRetained]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setBatchPreference(confirmed?.batchPreference ?? proposed?.batchLimit ?? legacyDraft?.batchPreference ?? 2);
      setThreshold(String(confirmed?.leadThreshold ?? proposed?.scoreLeadThreshold ?? legacyDraft?.leadThreshold ?? 4));
      setReturnToNormal(confirmed?.returnToNormal ?? proposed?.returnToNormalEnabled ?? legacyDraft?.returnToNormal ?? null);
      setStintMinutes(String((confirmed?.minimumStintMs ?? proposed?.minimumStintMs ?? 300_000) / 60_000));
      setBufferPercent(String((confirmed?.halfBufferFraction ?? match?.config.initialPolicyProposal?.softPreferences.halfBufferFraction ?? 0.15) * 100));
      setSettingsError(null);
    });
    return () => { active = false; };
  }, [confirmedFor, match?.config.matchId, confirmed?.batchPreference, confirmed?.leadThreshold, confirmed?.returnToNormal, proposed?.batchLimit, proposed?.scoreLeadThreshold, proposed?.returnToNormalEnabled, legacyDraft?.batchPreference, legacyDraft?.leadThreshold, legacyDraft?.returnToNormal, confirmed?.minimumStintMs, confirmed?.halfBufferFraction, proposed?.minimumStintMs, match?.config.initialPolicyProposal?.softPreferences.halfBufferFraction]);
  useEffect(() => { let active = true; void getAlertCapability().then(value => { if (active) setAlertCapability(value); }).catch(error => { if (active) setAlertError(error instanceof Error ? error.message : 'Notification capability could not be checked.'); }); return () => { active = false; }; }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      if (!match || !confirmed || confirmedFor !== match.config.matchId || !hasControl || preferencesRetained || recoveryRequired || match.status === 'completed' || match.status === 'abandoned') { setResult(null); setPlanning(false); return; }
      setPlanning(true);
      setPlanningError(null);
      try {
        const input = plannerInputFromMatch(match, sampleRef.current, confirmed, ++planVersion.current, match.activePolicy?.positionMode ?? 'normal');
        const planned = planMatch(input);
        if (active) { setResult(planned); setPlanning(false); }
      } catch (error) { if (active) { setResult(null); setPlanning(false); setPlanningError(error instanceof Error ? error.message : 'Planning could not be completed.'); } }
    });
    return () => { active = false; };
    // sample/clock render ticks are deliberately read from refs; they never run the solver.
  }, [match, confirmed, confirmedFor, preferencesRetained, requestVersion, hasControl, recoveryRequired]);

  const currentMatchId = match?.config.matchId;
  const currentResult = result?.planId === `${currentMatchId}-suggestion` ? result : null;
  const currentConfirmed = confirmedFor === currentMatchId ? confirmed : null;
  const matchStatus = match?.status;
  const currentHalf = match?.half;
  const revision = match?.revision;
  useEffect(() => {
    const next = currentResult?.status === 'feasible' ? currentResult.nextChange : null;
    const running = Boolean(next && next.half === currentHalf && matchStatus?.endsWith('_running') && hasControl && !recoveryRequired && currentResult?.sourceRevision === revision);
    const reminderRevision = currentResult ? `${currentResult.planId}-${currentResult.planVersion}-${currentResult.sourceRevision}` : 'no-current-plan';
    let active = true;
    void replaceLocalWarnings({ owner: alertOwner, revision: reminderRevision, dueInMs: next ? next.dueMatchActiveMs - (clockRef.current?.matchActiveMs ?? 0) : 0, running, leadSeconds: alertSettings.leadSeconds, sound: false }).catch(error => { if (active) setAlertError(error instanceof Error ? error.message : 'Local reminders could not be scheduled. Use the visual countdown.'); });
    return () => { active = false; void replaceLocalWarnings({ owner: alertOwner, revision: `${reminderRevision}-cancel`, dueInMs: 0, running: false }).catch(() => {}); };
  }, [currentResult, matchStatus, currentHalf, revision, hasControl, recoveryRequired, permissionVersion, alertOwner, alertSettings.leadSeconds]);

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

  useEffect(() => {
    const next = currentResult?.status === 'feasible' ? currentResult.nextChange : null;
    const update = substitutionToneAtCheckpoint({
      plan: next && next.half === currentHalf && currentResult ? { key: `${alertOwner}:${currentResult.planId}:${currentResult.planVersion}:${currentResult.sourceRevision}`, dueActiveMs: next.dueMatchActiveMs, sourceRevision: currentResult.sourceRevision } : null,
      activeMs: Math.max(0, Math.floor(clock?.matchActiveMs ?? 0)), sourceRevision: revision ?? 0,
      running: Boolean(matchStatus?.endsWith('_running')), hasControl, timeCertain: !recoveryRequired,
      foreground, settings: alertSettings, previous: toneState.current,
    });
    toneState.current = update.checkpoint;
    if (!hasControl || !foreground || !matchStatus?.endsWith('_running') || recoveryRequired) stopSubstitutionAudio(alertOwner);
    if (update.play && audioReady) void playSubstitutionAudio(alertSettings.volume, alertOwner).catch(error => setAudioMessage(error instanceof Error ? error.message : 'Audio is unavailable. Use the visual countdown.'));
  }, [currentResult, currentHalf, alertOwner, clock, revision, matchStatus, hasControl, recoveryRequired, foreground, alertSettings, audioReady]);
  const enableAudio = useCallback(async () => {
    if (!hasControl) return;
    try { await prepareSubstitutionAudio(); await playSubstitutionAudio(alertSettings.volume, alertOwner); setAudioReadyOwner(alertOwner); setAudioMessage('Audio enabled on this device. The test tone uses the saved team volume.'); }
    catch (error) { setAudioReadyOwner(null); setAudioMessage(error instanceof Error ? error.message : 'Audio could not be enabled.'); }
  }, [hasControl, alertSettings.volume, alertOwner]);

  const confirmSettings = useCallback(async () => {
    const leadThreshold = Number(threshold);
    if (!match || !preferencesReady || !hasControl || !commitPolicy || policySaving) { setSettingsError('Open this match with the available controller and journal before confirming settings.'); return false; }
    try {
      if (!stintMinutes.trim() || !bufferPercent.trim()) throw new Error('Choose explicit preferred spell and half-buffer values before confirming.');
      const settings = { batchPreference, leadThreshold, returnToNormal, minimumStintMs: Number(stintMinutes) * 60_000, halfBufferFraction: Number(bufferPercent) / 100 };
      assertConfirmedPlannerSettings(settings);
      const command = makePolicyChangeCommand(match, sampleRef.current, settings, reason);
      setSettingsError(null); setPolicySaving(true);
      const saved = await commitPolicy(command);
      if (saved) setReason('');
      return saved;
    } catch (error) { setSettingsError(error instanceof Error ? error.message : 'Planner settings are invalid.'); return false; }
    finally { setPolicySaving(false); }
  }, [threshold, batchPreference, returnToNormal, match, preferencesReady, hasControl, commitPolicy, policySaving, reason, stintMinutes, bufferPercent]);
  const resetPositionMode = useCallback(async () => {
    if (!match || !confirmed || !preferencesReady || !hasControl || !commitPolicy || policySaving) return false;
    try {
      setSettingsError(null); setPolicySaving(true);
      return await commitPolicy(makePolicyChangeCommand(match, sampleRef.current, confirmed, 'Manager explicitly reset future position suggestions to normal.', true));
    } catch(error) { setSettingsError(error instanceof Error ? error.message : 'The position-mode reset was not saved.'); return false; }
    finally { setPolicySaving(false); }
  }, [match, confirmed, preferencesReady, hasControl, commitPolicy, policySaving]);
  const requestNotifications = useCallback(async () => {
    try { setAlertCapability(await requestAlertPermission()); setAlertError(null); setPermissionVersion(value => value + 1); }
    catch (error) { setAlertError(error instanceof Error ? error.message : 'Permission request failed. Keep the visual console open.'); }
  }, []);
  const nextChange = currentResult?.status === 'feasible' && currentResult.sourceRevision === revision ? currentResult.nextChange : null;
  const awaitingHalfTime = Boolean(nextChange?.half === 2 && currentHalf === 1 && matchStatus !== 'half_time');
  const countdown: SubstitutionCountdownSnapshot = { dueInMs: nextChange ? nextChange.dueMatchActiveMs - (clock?.matchActiveMs ?? 0) : null, state: !hasControl || recoveryRequired ? 'unavailable' : awaitingHalfTime || matchStatus === 'half_time' ? 'half_time' : matchStatus?.endsWith('_running') ? 'running' : matchStatus?.endsWith('_paused') ? 'paused' : 'waiting', outgoing: nextChange?.outgoingPlayerIds.map(id => match?.config.players.find(player => player.id === id)?.displayName ?? id) ?? [], incoming: nextChange?.incomingPlayerIds.map(id => match?.config.players.find(player => player.id === id)?.displayName ?? id) ?? [] };
  return { countdown, alertSettings, audioReady, audioMessage, enableAudio, match, awaitingHalfTime, batchPreference, setBatchPreference, threshold, setThreshold, returnToNormal, setReturnToNormal, confirmed: currentConfirmed, confirmSettings, settingsError: settingsError ?? preferences.permissionError, preferencesReady, preferencesSaving: preferences.busy || policySaving || Boolean(context.policy?.busy), preferencesRetained, preferencesConflict: preferences.conflict || Boolean(context.policy?.conflict), retryPreferences: context.policy?.retryPending && context.policy.retry ? context.policy.retry : preferences.retry, reloadPreferences: context.policy?.conflict && context.policy.reload ? context.policy.reload : preferences.reload, storageAvailable: preferences.storageAvailable, positionMode: match?.activePolicy?.positionMode ?? 'normal', reason, setReason, stintMinutes, setStintMinutes, bufferPercent, setBufferPercent, policyVersion: match?.activePolicy?.policyVersion ?? null, policyAcknowledged: match?.activePolicy && context.policy?.acceptedRevision !== undefined ? context.policy.acceptedRevision >= match.activePolicy.revision : null, legacySettingsRetained: !match?.activePolicy && Boolean(preferenceRecord?.settings), resetPositionMode, result: currentResult, planningError, planning, replan: () => setRequestVersion(value => value + 1), nextChange, dueInMs: nextChange ? nextChange.dueMatchActiveMs - (clock?.matchActiveMs ?? 0) : null, alertCapability, alertError, lastWarning, requestNotifications, hasControl, setHasControl, timeCertain: !recoveryRequired };
}
export type PlannerModel = ReturnType<typeof usePlannerModel>;

function duration(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
export function PlannerPanel({ model, onReviewLineup, hideCountdown = false }: { model: PlannerModel; hideCountdown?: boolean; onReviewLineup: (lineup: Allocation[], sourceRevision: number) => void }) {
  const [editing, setEditing] = useState(false);
  const label = (id: string) => model.match?.config.players.find(player => player.id === id)?.displayName ?? id;
  const next = model.nextChange;
  return <View style={styles.stack}>
    {!hideCountdown && model.match?.half !== 0 && !['completed', 'abandoned'].includes(model.match?.status ?? '') && <SubstitutionCountdown value={model.countdown} />}
    <Card>
      <View style={styles.heading}><Text style={typography.section}>Playing-time plan</Text><Pill tone="muted">MANAGER SUGGESTION</Pill></View>
      <Text style={typography.body}>Fair time, with every change confirmed by you.</Text>
      {!model.preferencesReady && !model.settingsError && <Notice>{model.storageAvailable ? 'Opening this match’s saved planner settings…' : 'Open this device’s match journal before confirming planner settings.'}</Notice>}
      {model.preferencesRetained && !model.preferencesSaving && !model.preferencesConflict && <Button label="Retry planner settings save" disabled={!model.hasControl} onPress={() => { void model.retryPreferences(); }} />}
      {model.preferencesConflict && <Button label="Reload saved planner settings; retain conflict" onPress={model.reloadPreferences} />}
      {!model.confirmed || editing ? <View style={styles.stack}>
        <Notice tone="info">Roma’s suggested starting values are five-minute playing spells and 15% half buffers. Review the flexible preferences below; they never become a hard grid or constraint.</Notice>
        <Text style={typography.label}>Preferred continuous playing spell · minutes</Text>
        <TextInput accessibilityLabel="Preferred continuous spell minutes" keyboardType="decimal-pad" editable={!model.preferencesRetained} value={model.stintMinutes} onChangeText={model.setStintMinutes} style={styles.input} />
        <Text style={typography.label}>Avoid routine changes at each half’s start/end · percent</Text>
        <TextInput accessibilityLabel="Preferred half buffer percent" keyboardType="decimal-pad" editable={!model.preferencesRetained} value={model.bufferPercent} onChangeText={model.setBufferPercent} style={styles.input} />
        <Text style={typography.label}>Preferred batch size · proposed starting value 2</Text>
        <View style={styles.row}>
          <Button label="−" variant="secondary" disabled={model.preferencesRetained || model.batchPreference <= 1} onPress={() => model.setBatchPreference(Math.max(1, model.batchPreference - 1))} />
          <Text style={styles.settingNumber}>{model.batchPreference}</Text>
          <Button label="+" variant="secondary" disabled={model.preferencesRetained || model.batchPreference >= 11} onPress={() => model.setBatchPreference(Math.min(11, model.batchPreference + 1))} />
        </View>
        <Text style={typography.muted}>This is a preference, with no hard batch cap or mandatory five-minute grid.</Text>
        <Text style={typography.label}>Score lead for adventurous positions</Text>
        <TextInput accessibilityLabel="Score lead threshold" keyboardType="number-pad" editable={!model.preferencesRetained} value={model.threshold} onChangeText={model.setThreshold} style={styles.input} />
        <Text style={typography.label}>Return to normal when the lead falls?</Text>
        <View style={styles.row}>
          <Button label={model.returnToNormal === true ? 'Yes · selected' : 'Yes'} disabled={model.preferencesRetained} variant={model.returnToNormal === true ? 'primary' : 'secondary'} onPress={() => model.setReturnToNormal(true)} />
          <Button label={model.returnToNormal === false ? 'No · selected' : 'No'} disabled={model.preferencesRetained} variant={model.returnToNormal === false ? 'primary' : 'secondary'} onPress={() => model.setReturnToNormal(false)} />
        </View>
        <Text style={typography.muted}>Position weights and Q07 target calculations remain demo experiments. Keeper-policy transitions remain unapproved and are refused; confirming these soft preferences cannot approve them.</Text>
        {model.legacySettingsRetained && <Notice>Earlier device-only settings were retained as a review draft. They are not yet part of this match’s accepted policy history.</Notice>}
        <Text style={typography.label}>Reason for these future settings</Text>
        <TextInput accessibilityLabel="Match policy change reason" value={model.reason} onChangeText={model.setReason} editable={!model.preferencesRetained} multiline maxLength={500} style={styles.input} />
        {model.settingsError && <Notice tone="error">{model.settingsError}</Notice>}
        <Button label={model.preferencesSaving ? 'Saving settings…' : 'Confirm settings and plan'} testID="planner-settings-confirm" disabled={!model.preferencesReady || !model.hasControl || model.preferencesRetained} onPress={() => { void model.confirmSettings().then(saved => { if (saved) setEditing(false); }); }} />
      </View> : <View style={styles.stack}>
        <Text style={typography.muted} testID="planner-settings-saved">Preferred batch {model.confirmed.batchPreference} · lead {model.confirmed.leadThreshold} · return to normal {model.confirmed.returnToNormal ? 'on' : 'off'}. Preferred spell {model.confirmed.minimumStintMs / 60_000} min · half buffer {model.confirmed.halfBufferFraction * 100}%. Saved as match policy version {model.policyVersion}.</Text>
        <Text style={typography.muted}>{model.policyAcknowledged === true ? 'Acknowledged by the service; policy history follows controller handover.' : model.policyAcknowledged === false ? 'Saved on this device; service acknowledgement is still pending.' : 'Saved in this device’s durable match event history.'}</Text>
        <Text style={typography.muted} testID="planner-position-mode">Position mode: {model.positionMode}. The saved match mode survives closing this panel.</Text>
        {model.settingsError && <Notice tone="error">{model.settingsError}</Notice>}
        <Button label="Review settings" variant="quiet" disabled={model.preferencesRetained} onPress={() => setEditing(true)} />
        <Button label="Reset adventurous mode to normal" testID="planner-reset-normal" variant="secondary" disabled={model.preferencesRetained || !model.hasControl || model.positionMode === 'normal'} onPress={() => { void model.resetPositionMode(); }} />
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
      <Text style={typography.muted}>The saved team warning is {model.alertSettings.leadSeconds} seconds before each planned batch. Silent local notifications and the visual countdown follow the current plan. Pause, half-time, recovery, replan and control loss cancel them.</Text>
      <Text style={typography.body}>{model.alertSettings.enabled ? `Team audio on · volume ${Math.round(model.alertSettings.volume * 100)}%` : 'Team audio is off. Change it under Team → Substitution audio.'}</Text>
      <Button label={model.audioReady ? 'Test sound again' : 'Enable audio for this device'} testID="enable-substitution-audio" compact variant="secondary" disabled={!model.hasControl || !model.alertSettings.enabled} onPress={() => { void model.enableAudio(); }} />
      {model.audioMessage && <Notice>{model.audioMessage}</Notice>}
      <Text style={typography.muted}>{substitutionAudioCapability}</Text>
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
