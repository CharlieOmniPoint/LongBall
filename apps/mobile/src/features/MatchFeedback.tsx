import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import type { MatchFeedbackCommand, MatchFeedbackEntry, MatchFeedbackMatch, MatchFeedbackView } from '@longball/application/match-feedback';
import { formatUkDate, formatUkDateTime } from '@longball/application/uk-display';
import { acknowledgeRevisionedValueDraft, refreshRevisionedValueDraft, reviewRevisionedValueDraft, revisionedValueDraft, revisionedValueNeedsReview } from '../platform/revisioned-value-draft';
import { randomUUID } from '../platform/id';
import { Button, Card, Notice, Pill } from '../ui';
import { colors, typography } from '../ui/tokens';
import { MatchFeedbackRating, type MatchFeedbackRatingValue } from './MatchFeedbackRating';

export interface MatchFeedbackProps {
  value: MatchFeedbackView;
  disabled?: boolean;
  onSave?: (command: MatchFeedbackCommand) => Promise<boolean>;
  onRefresh?: () => Promise<void>;
}
type FeedbackFields = { rating: MatchFeedbackRatingValue | null; text: string };
const validRating = (value: number | null | undefined): value is MatchFeedbackRatingValue => Number.isInteger(value) && value! >= 1 && value! <= 5;
const fields = (entry: MatchFeedbackEntry | null): FeedbackFields => ({ rating: validRating(entry?.rating) ? entry.rating : null, text: entry?.text ?? '' });
const characterCount = (text: string) => Array.from(text).length;
const feedbackTextValid = (text: string) => characterCount(text) <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);

/** Private projections come from the service. This component never grants access or derives a cutoff from the device clock. */
export function MatchFeedback(props: MatchFeedbackProps) {
  const { value } = props;
  if (value.kind !== 'match-feedback' || !['player', 'manager'].includes(value.audience)) return null;
  if (value.audience === 'player' && !value.playerId) return <Notice>Match feedback is unavailable until your player assignment is confirmed.</Notice>;
  return <MatchFeedbackContent key={`${value.accountId}:${value.teamId}:${value.seasonId}:${value.audience}:${value.playerId ?? ''}`} {...props} />;
}

function MatchFeedbackContent({ value, disabled = false, onSave, onRefresh }: MatchFeedbackProps) {
  const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState(false);
  const refreshLock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = disabled || refreshing;
  return <View style={s.stack} testID="match-feedback">
    <Card>
      <Text accessibilityRole="header" style={typography.section}>{value.audience === 'manager' ? 'Players’ match feedback' : 'My match feedback'}</Text>
      <Text style={typography.body}>{value.audience === 'manager' ? 'Private feedback from players with recorded playing time. Only the player’s account and assigned team managers can read an entry.' : 'Your match rating and optional note are private to your account and assigned team managers.'}</Text>
      <Text style={typography.muted}>Editing closes at midnight in Europe/London on the day the game actually finished. Saved feedback remains readable afterwards.</Text>
      {onRefresh && <Button compact label={refreshing ? 'Refreshing feedback…' : 'Refresh match feedback'} testID="match-feedback-refresh" variant="secondary" disabled={locked} onPress={() => {
        if (refreshLock.current) return;
        refreshLock.current = true; setRefreshing(true); setRefreshError(false);
        void onRefresh().catch(() => { if (mounted.current) setRefreshError(true); }).finally(() => { refreshLock.current = false; if (mounted.current) setRefreshing(false); });
      }} />}
      {refreshing && <ActivityIndicator color={colors.brand} />}
      {refreshError && <Notice tone="error">Match feedback could not be refreshed. The last confirmed view and your drafts are retained.</Notice>}
    </Card>
    {value.matches.length === 0 && <Notice>Match feedback will appear after completed games.</Notice>}
    {value.matches.map(match => <Card key={match.matchId}>
      <View style={s.stack} testID={`match-feedback-${match.matchId}`}>
        <Text accessibilityRole="header" style={typography.section}>{match.label}</Text>
        {match.playedDate && <Text style={typography.muted}>{formatUkDate(match.playedDate)}</Text>}
        <Pill tone={match.status === 'open' ? 'brand' : match.status === 'review_required' ? 'warning' : 'muted'}>{match.status === 'open' ? 'Feedback open' : match.status === 'closed' ? 'Editing closed' : 'Completion needs review'}</Pill>
        {match.closesAtMs !== null && <Text style={typography.body}>Editing closes: {formatUkDateTime(match.closesAtMs)} · Europe/London</Text>}
        {value.audience === 'manager' ? <ManagerFeedback match={match} /> : <PlayerFeedback match={match} playerId={value.playerId!} disabled={locked} onSave={onSave} />}
      </View>
    </Card>)}
  </View>;
}

function SavedFeedback({ entry, label = 'Saved feedback' }: { entry: MatchFeedbackEntry; label?: string }) {
  return <View style={s.saved}>
    <Text style={typography.label}>{label}</Text>
    <Text style={typography.body}>Rating: {entry.rating} out of 5</Text>
    {entry.text ? <Text style={typography.body}>{entry.text}</Text> : <Text style={typography.muted}>No note added.</Text>}
    <Text style={typography.muted}>Last saved {formatUkDateTime(entry.updatedAtMs)} · Europe/London</Text>
  </View>;
}

function ManagerFeedback({ match }: { match: MatchFeedbackMatch }) {
  return <View style={s.stack} testID="match-feedback-manager-view">
    {match.status === 'review_required' && <Notice>New feedback cannot be saved until the game’s completion record is confirmed. Existing saved entries remain below.</Notice>}
    {!match.entries?.length && <Text style={typography.muted}>No player feedback has been saved for this game.</Text>}
    {(match.entries ?? []).map(entry => <SavedFeedback key={entry.playerId} entry={entry} label={entry.playerLabel} />)}
  </View>;
}

function PlayerFeedback({ match, playerId, disabled, onSave }: { match: MatchFeedbackMatch; playerId: string; disabled: boolean; onSave?: MatchFeedbackProps['onSave'] }) {
  const source = fields(match.own), revision = match.own?.revision ?? 0;
  const [draft, setDraft] = useState(() => revisionedValueDraft(source, revision));
  const [review, setReview] = useState<MatchFeedbackCommand | null>(null);
  const [acknowledged, setAcknowledged] = useState<{ submitted: FeedbackFields; sourceRevision: number } | null>(null);
  const [sending, setSending] = useState(false), [attempted, setAttempted] = useState(false), [failed, setFailed] = useState(false), [saved, setSaved] = useState(false);
  const sendingRef = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  let nextDraft = draft.revision !== revision || JSON.stringify(draft.source) !== JSON.stringify(source) ? refreshRevisionedValueDraft(draft, source, revision) : draft;
  if (acknowledged && revision > acknowledged.sourceRevision) {
    nextDraft = acknowledgeRevisionedValueDraft(nextDraft, acknowledged.submitted);
    setAcknowledged(null);
  }
  if (nextDraft !== draft) setDraft(nextDraft);
  if (match.own && match.own.playerId !== playerId) return <Notice tone="error">This feedback view does not match your current player assignment. Refresh your team view.</Notice>;
  const editable = match.status === 'open' && match.eligible && match.canEdit && !!onSave;
  const stale = revisionedValueNeedsReview(draft) || !!review && review.expectedRevision !== revision;
  const changed = JSON.stringify(draft.value) !== JSON.stringify(draft.baseline);
  const locked = disabled || sending || !editable;
  const awaitingReceiptView = acknowledged !== null;
  const update = (change: Partial<FeedbackFields>) => { setDraft(current => ({ ...current, value: { ...current.value, ...change } })); setReview(null); setAttempted(false); setFailed(false); setSaved(false); };
  return <View style={s.stack} testID="match-feedback-player-view">
    {match.own && <SavedFeedback entry={match.own} label="Your saved feedback" />}
    {!match.eligible && <Notice>Feedback is available only to players with recorded playing time in this game.</Notice>}
    {match.status === 'review_required' && <Notice>The game’s completion record needs confirmation before feedback can be edited.</Notice>}
    {match.status === 'closed' && !match.own && <Text style={typography.muted}>No feedback was saved before editing closed.</Text>}
    {!editable && changed && <View style={s.saved}>
      <Notice tone="warning">Your unsaved draft is retained below. It has not been saved, and editing is currently unavailable.</Notice>
      <Text style={typography.body}>Draft rating: {draft.value.rating ?? 'Not chosen'}</Text>
      {!!draft.value.text && <Text style={typography.body}>{draft.value.text}</Text>}
    </View>}
    {saved && <Notice>The reviewed feedback was saved.</Notice>}
    {failed && <Notice tone="error">Feedback has not been confirmed. Your draft and reviewed request are retained. Retry the same feedback or refresh the latest record before editing.</Notice>}
    {editable && <>
      {stale && <View style={s.stack}>
        <Notice tone="warning">Your saved feedback changed while you were editing. Compare the latest saved entry above with your draft before saving again.</Notice>
        <Button compact label="I have reviewed the latest feedback; keep my draft" testID="match-feedback-review-latest" variant="secondary" disabled={disabled || sending} onPress={() => { setDraft(current => reviewRevisionedValueDraft(current)); setReview(null); setAttempted(false); setFailed(false); setSaved(false); }} />
      </View>}
      {!review ? <>
        <MatchFeedbackRating value={draft.value.rating} disabled={locked || awaitingReceiptView} onChange={rating => update({ rating })} />
        <Text style={typography.label}>Optional note</Text>
        <TextInput
          accessibilityLabel="Optional match feedback note"
          testID="match-feedback-note"
          value={draft.value.text}
          onChangeText={text => update({ text })}
          multiline
          maxLength={512}
          editable={!locked && !awaitingReceiptView}
          style={s.input}
        />
        <Text style={typography.muted}>{characterCount(draft.value.text)} of 256 characters</Text>
        {!feedbackTextValid(draft.value.text) && <Notice tone="error">Use at most 256 characters and remove unsupported control characters.</Notice>}
        <Button label="Review my feedback" testID="match-feedback-review" disabled={locked || awaitingReceiptView || stale || !changed || !validRating(draft.value.rating) || !feedbackTextValid(draft.value.text)} onPress={() => {
          if (!validRating(draft.value.rating)) return;
          const text = draft.value.text.trim();
          setDraft(current => ({ ...current, value: { ...current.value, text } }));
          setReview({ id: randomUUID(), type: 'feedback.saved', matchId: match.matchId, expectedRevision: draft.expectedRevision, rating: draft.value.rating, text: text || null });
          setAttempted(false); setFailed(false); setSaved(false);
        }} />
      </> : <View style={s.stack}>
        <Text accessibilityRole="header" style={typography.section}>Review your feedback</Text>
        <Text style={typography.body}>Rating: {review.rating} out of 5</Text>
        {review.text ? <Text style={typography.body}>{review.text}</Text> : <Text style={typography.muted}>No note added.</Text>}
        <Text style={typography.muted}>Only your account and assigned team managers can read this feedback. Changes must be saved before editing closes.</Text>
        <Button label={sending ? 'Saving feedback…' : attempted ? 'Retry the same feedback' : 'Confirm and save my feedback'} testID="match-feedback-save" disabled={locked || stale || awaitingReceiptView} onPress={() => {
          if (sendingRef.current || !onSave) return;
          const submitted = review;
          sendingRef.current = true; setSending(true); setAttempted(true); setFailed(false); setSaved(false);
          void onSave(submitted).then(accepted => {
            if (!mounted.current) return;
            if (accepted) {
              setAcknowledged({ submitted: { rating: submitted.rating as MatchFeedbackRatingValue, text: submitted.text ?? '' }, sourceRevision: submitted.expectedRevision });
              setReview(null); setFailed(false); setSaved(true);
            } else setFailed(true);
          }).catch(() => { if (mounted.current) setFailed(true); }).finally(() => { sendingRef.current = false; if (mounted.current) setSending(false); });
        }} />
        <Button compact label="Edit my feedback draft" testID="match-feedback-edit-draft" variant="secondary" disabled={locked || awaitingReceiptView} onPress={() => { setReview(null); setFailed(false); }} />
      </View>}
    </>}
  </View>;
}

const s = StyleSheet.create({
  stack: { gap: 12 },
  saved: { gap: 6, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 },
  input: { minHeight: 104, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 8, padding: 12, fontSize: 16, color: colors.ink, backgroundColor: colors.surface, textAlignVertical: 'top' },
});
