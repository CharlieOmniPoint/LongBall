import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import {
  applyCommunityCommand, getCommunityView, ownCommunityExport,
  type CommunityActor, type CommunityCommand, type CommunityState, type FictionalArt,
} from '@longball/application/community';
import { Button, Card, colors, Notice, Pill } from '../ui';
import { randomUUID } from '../platform/id';

export interface CommunityScreensProps {
  state: CommunityState;
  onChange: (next: CommunityState) => void | boolean | Promise<void | boolean>;
  actor: CommunityActor;
  section?: 'all' | 'photos' | 'invitations' | 'awards' | 'account';
  nowMs?: number;
}

/** Original vector illustrations only; this never renders an unapproved raw upload. */
function FictionalImage({ art, small = false }: { art: FictionalArt; small?: boolean }) {
  return <View accessible accessibilityLabel={`Fictional ${art} illustration; no people`} style={[s.art, small && { maxHeight: 128 }]}>
    <Svg width="100%" height={small ? 112 : 170} viewBox="0 0 320 180">
      <Rect width="320" height="180" fill={art === 'cones' ? '#E4EEE7' : '#176B45'} />
      {art === 'pitch' ? <>
        <Rect x="22" y="16" width="276" height="148" fill="none" stroke="white" strokeWidth="3" />
        <Line x1="160" y1="16" x2="160" y2="164" stroke="white" strokeWidth="3" />
        <Circle cx="160" cy="90" r="28" fill="none" stroke="white" strokeWidth="3" />
        <Rect x="22" y="52" width="42" height="76" fill="none" stroke="white" strokeWidth="3" />
        <Rect x="256" y="52" width="42" height="76" fill="none" stroke="white" strokeWidth="3" />
        <Circle cx="160" cy="90" r="4" fill="white" />
      </> : art === 'ball' ? <>
        <Circle cx="160" cy="91" r="60" fill="white" stroke="#14251D" strokeWidth="3" />
        <Path d="M160 62 L184 80 L175 108 L145 108 L136 80 Z M160 31 L160 62 M219 72 L184 80 M195 140 L175 108 M125 140 L145 108 M101 72 L136 80" stroke="#14251D" strokeWidth="6" fill="#14251D" />
      </> : <>
        <Path d="M61 133 L90 57 L119 133 Z M141 145 L170 69 L199 145 Z M217 116 L239 58 L261 116 Z" fill="#D88820" stroke="#7B4900" strokeWidth="3" />
        <Path d="M72 105 L108 105 M152 117 L188 117 M226 94 L252 94" stroke="white" strokeWidth="8" />
        <Line x1="40" y1="154" x2="280" y2="154" stroke="#126946" strokeWidth="3" />
      </>}
    </Svg>
    <Text style={s.artLabel}>FICTIONAL ILLUSTRATION</Text>
  </View>;
}

function dateTime(value: number | null): string {
  return value === null ? 'Not recorded' : new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
type CommandPayload = CommunityCommand extends infer C ? C extends CommunityCommand ? Omit<C, 'id' | 'expectedRevision'> : never : never;
function prepareCommunityWrite(state: CommunityState, actor: CommunityActor, command: CommunityCommand, suppliedTime?: number) {
  // Receipt time is sampled at the mutation boundary, never while drawing a view.
  return applyCommunityCommand(state, actor, command, suppliedTime ?? Date.now());
}
function DialogSheet({ children }: { children: ReactNode }) {
  return <ScrollView style={s.sheet} contentContainerStyle={s.sheetContent} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}

export function CommunityScreens(props: CommunityScreensProps) {
  // A changed account/context gets a fresh component. Private drafts/exports and
  // modal content must never survive a role switch for even a render.
  return <CommunityContent key={`${props.actor.accountId}:${props.actor.role}:${props.actor.teamId}:${props.actor.seasonId}`} {...props} />;
}

function CommunityContent({ state, onChange, actor, section = 'all', nowMs }: CommunityScreensProps) {
  const [clock, setClock] = useState(() => nowMs ?? Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [retry, setRetry] = useState<CommunityCommand | null>(null);
  const [inviteHours, setInviteHours] = useState('');
  const [reviewCode, setReviewCode] = useState('');
  const [cutoffMinutes, setCutoffMinutes] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [art, setArt] = useState<FictionalArt>('pitch');
  const [caption, setCaption] = useState('');
  const [policyAcknowledged, setPolicyAcknowledged] = useState(false);
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<{ type: 'photo' | 'uploader'; id: string } | null>(null);
  const [reportCategory, setReportCategory] = useState<'privacy' | 'inappropriate' | 'other'>('privacy');
  const [reportExplanation, setReportExplanation] = useState('');
  const [hideConfirmation, setHideConfirmation] = useState<{ id: string; label: string } | null>(null);
  const [closeAward, setCloseAward] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [quietStart, setQuietStart] = useState(state.preferences[actor.accountId]?.quietStart ?? '');
  const [quietEnd, setQuietEnd] = useState(state.preferences[actor.accountId]?.quietEnd ?? '');
  useEffect(() => {
    if (nowMs !== undefined) return;
    const interval = setInterval(() => setClock(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, [nowMs]);
  const view = getCommunityView(state, actor, nowMs ?? clock);
  const included = (name: Exclude<CommunityScreensProps['section'], undefined | 'all'>) => section === 'all' || section === name;
  const viewer = view.gallery.find(item => item.id === viewerId);
  const submit = async (command: CommunityCommand) => {
    if (busy) return false;
    setBusy(true); setError(null); setSaved(null);
    try {
      const next = prepareCommunityWrite(state, actor, command, nowMs);
      const committed = await onChange(next);
      if (committed === false) throw new Error('The local write did not finish. Your action is retained for the same-identity retry.');
      setRetry(null); setSaved('Saved in this fictional review.');
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The action could not be saved.');
      setRetry(command);
      return false;
    } finally { setBusy(false); }
  };
  const run = (payload: CommandPayload) => submit({ ...payload, id: randomUUID(), expectedRevision: state.revision } as CommunityCommand);
  const personalAccount = <View style={s.stack}>
    <Card>
      <Text style={s.heading}>My account</Text>
      <Text style={s.body}>{view.accountLabel}</Text>
      <Text style={s.muted}>This is a fictional role review, not a signed-in identity session. Parent use of a child account keeps the same permissions and single ballot.</Text>
      <Text style={s.label}>Memberships on this global account</Text>
      {view.memberships.map((membership, index) => <Text key={`${membership.teamId}:${membership.role}:${index}`} style={s.body}>{membership.role} · {membership.teamId === actor.teamId ? view.teamLabel : membership.teamId} · {membership.active ? 'Active' : 'Archived'}</Text>)}
      <Text style={s.label}>Notifications</Text>
      {(['schedule', 'match', 'awards', 'photos'] as const).map(key => <View key={key} style={s.settingRow}>
        <Text style={s.body}>{key.charAt(0).toUpperCase() + key.slice(1)} updates</Text>
        <Switch accessibilityLabel={`${key} updates`} value={view.preferences[key]} disabled={busy} onValueChange={value => void run({ type: 'preferences.changed', preferences: { ...view.preferences, [key]: value } })} />
      </View>)}
      <Text style={s.muted}>Preferences are saved locally. Remote push delivery is not connected.</Text>
      <TextInput style={s.input} value={quietStart} onChangeText={setQuietStart} placeholder="Quiet hours start HH:MM" placeholderTextColor={colors.inkMuted} accessibilityLabel="Quiet hours start" autoCapitalize="none" />
      <TextInput style={s.input} value={quietEnd} onChangeText={setQuietEnd} placeholder="Quiet hours end HH:MM" placeholderTextColor={colors.inkMuted} accessibilityLabel="Quiet hours end" autoCapitalize="none" />
      <Button label="Save quiet hours" variant="secondary" disabled={busy} onPress={() => void run({ type: 'preferences.changed', preferences: { ...view.preferences, quietStart: quietStart || null, quietEnd: quietEnd || null } })} />
    </Card>
    <Card>
      <Text style={s.heading}>Hidden uploaders</Text>
      <Text style={s.muted}>Hiding changes your gallery only. Official match records and manager moderation are unaffected.</Text>
      {view.hiddenUploaders.length ? view.hiddenUploaders.map(uploader => <View key={uploader.id} style={s.stack}>
        <Text style={s.body}>{uploader.label}</Text><Button label={`Unhide ${uploader.label}`} variant="secondary" disabled={busy} onPress={() => void run({ type: 'uploader.hidden', uploaderAccountId: uploader.id, hidden: false })} />
      </View>) : <Text style={s.body}>No uploaders hidden.</Text>}
    </Card>
    <Card>
      <Text style={s.heading}>My concerns</Text>
      {view.ownConcerns.length ? view.ownConcerns.map(concern => <View key={concern.id} style={s.stack}><Pill tone="info">{concern.status.replaceAll('_', ' ')}</Pill><Text selectable style={s.muted}>Reference {concern.id}</Text></View>) : <Text style={s.body}>No concerns submitted in this fictional review.</Text>}
      <Text style={s.muted}>Reports about a manager require operator escalation. The operator contact and safeguarding cover remain launch prerequisites.</Text>
    </Card>
    <Card>
      <Text style={s.heading}>Account data and deletion</Text>
      <Text style={s.body}>These actions concern this global account across teams. Leaving a team or revoking one spectator grant is different.</Text>
      <Button label="Preview my own data export" variant="secondary" testID="community-own-export" onPress={() => setExportPreview(JSON.stringify(ownCommunityExport(state, actor), null, 2))} />
      <Button label="Prepare export request" variant="secondary" disabled={busy} onPress={() => void run({ type: 'privacy.drafted', requestId: randomUUID(), requestType: 'export' })} />
      <Button label="Prepare global account deletion request" variant="danger" disabled={busy} onPress={() => setDeleteConfirmation(true)} />
      <Notice tone="warning">Requests remain local drafts needing verified account-level submission. Recovery authority, retention and deletion policy are unresolved. No account or match journal is removed by this screen.</Notice>
      {view.privacyRequests.map(request => <View key={request.id} style={s.stack}><Text style={s.label}>{request.type === 'export' ? 'Export' : 'Global account deletion'} · {request.status.replaceAll('_', ' ')}</Text><Text style={s.muted}>Local draft · reference {request.id}</Text>{request.status !== 'cancelled' && <Button label="Cancel this draft" variant="quiet" disabled={busy} onPress={() => void run({ type: 'privacy.cancelled', requestId: request.id })} />}</View>)}
      {exportPreview !== null && <><Text style={s.label}>Own-data preview · no other players’ ballots</Text><Text selectable style={s.code}>{exportPreview}</Text><Button label="Close export preview" variant="quiet" onPress={() => setExportPreview(null)} /></>}
    </Card>
  </View>;

  const invitationSection = <View style={s.stack}>
    <Text style={s.heading}>Invitations and access</Text>
    <Notice>Fictional review codes exercise individual acceptance and expiry. Real activation requires an authenticated existing identity or the token-bound account activation service.</Notice>
    {view.allowed && actor.role !== 'spectator' && <Card>
      <Text style={s.label}>Invite a spectator to {view.teamLabel}</Text>
      <Text style={s.muted}>{view.seasonLabel} only. Accepted access ends at the season boundary and is renewed explicitly. Players’ invitations do not need an extra approval step.</Text>
      <TextInput style={s.input} keyboardType="numeric" value={inviteHours} onChangeText={setInviteHours} placeholder="Choose validity in hours" placeholderTextColor={colors.inkMuted} accessibilityLabel="Invitation validity in hours" />
      <Button label="Create fictional spectator invitation" testID="community-create-invite" disabled={busy || !inviteHours.trim()} onPress={() => void run({ type: 'invite.created', invitationId: randomUUID(), reviewCode: `DEMO-${randomUUID().slice(0, 12).toUpperCase()}`, expiresAtMs: (nowMs ?? Date.now()) + Number(inviteHours) * 3_600_000 })} />
      {view.invitations.length === 0 && <Text style={s.muted}>No invitations created in this team context.</Text>}
      {view.invitations.map(invite => <View key={invite.id} style={s.inviteRow}>
        <Text selectable style={s.label}>{invite.reviewCode}</Text>
        <Text style={s.muted}>{invite.revokedAtMs !== null ? 'Revoked' : invite.acceptedBy ? 'Accepted' : (nowMs ?? clock) >= invite.expiresAtMs ? 'Expired' : 'Awaiting acceptance'} · expires {dateTime(invite.expiresAtMs)}</Text>
        {actor.role === 'manager' && invite.revokedAtMs === null && <Button label="Revoke invitation and linked access" variant="danger" disabled={busy} onPress={() => void run({ type: 'invite.revoked', invitationId: invite.id })} />}
      </View>)}
    </Card>}
    <Card>
      <Text style={s.label}>Accept as this existing fictional account</Text>
      <Text style={s.body}>{view.accountLabel}</Text>
      <TextInput style={s.input} value={reviewCode} onChangeText={setReviewCode} placeholder="Enter individual DEMO code" placeholderTextColor={colors.inkMuted} accessibilityLabel="Fictional invitation code" autoCapitalize="characters" />
      <Button label="Accept fictional invitation" testID="community-accept-invite" disabled={busy || !reviewCode.trim()} onPress={() => void run({ type: 'invite.accepted', reviewCode: reviewCode.trim() })} />
      <Text style={s.muted}>The account identity is reused. This never creates a second player identity or an extra ballot.</Text>
    </Card>
    {actor.role === 'manager' && view.allowed && <Card><Text style={s.label}>Current and past spectator grants</Text>
      {view.grants.map(grant => <View key={grant.id} style={s.stack}><Text style={s.body}>{grant.accountLabel}</Text><Text style={s.muted}>{grant.revokedAtMs !== null ? 'Revoked' : (nowMs ?? clock) >= grant.expiresAtMs ? 'Expired' : 'Active'} · season ends {dateTime(grant.expiresAtMs)}</Text>{grant.revokedAtMs === null && <Button label={`Revoke access for ${grant.accountLabel}`} variant="danger" disabled={busy} onPress={() => void run({ type: 'grant.revoked', grantId: grant.id })} />}</View>)}
    </Card>}
  </View>;

  return <View style={s.stack}>
    <Pill tone="info">{view.teamLabel} · {view.seasonLabel} · Fictional {actor.role} review</Pill>
    {error && <Notice tone="error">{error}</Notice>}
    {retry && error && <Button label="Retry retained action" variant="secondary" disabled={busy} onPress={() => void submit(retry)} />}
    {saved && <Text accessibilityLiveRegion="polite" style={s.muted}>{saved}</Text>}
    {!view.allowed && <Notice tone="warning">{view.accessMessage}</Notice>}
    {included('invitations') && invitationSection}
    {view.allowed && included('awards') && <View style={s.stack}>
      <Text style={s.heading}>Players’ award</Text>
      <Text style={s.body}>One private, changeable teammate choice per eligible player. Parent use shares that same choice. No running totals or individual ballots are disclosed.</Text>
      {!view.matches.length && <Notice>No match ballot is available yet.</Notice>}
      {view.matches.map(match => <Card key={match.id}>
        <Text style={s.label}>{match.label}</Text>
        {!match.sharingAllowed ? <Notice>Recognition and match context are withheld by the current competition policy.</Notice> : <>
          <Text style={s.muted}>Original full time {dateTime(match.fullTimeAtMs)}</Text>
          <Text style={s.label}>Voting closes: {match.cutoffAtMs === null ? 'Awaiting an explicit cutoff' : dateTime(match.cutoffAtMs)}</Text>
          <Text style={s.label}>Result due by: {dateTime(match.deadlineAtMs)}</Text>
          {match.finishQuality !== 'trusted' && <Notice tone="warning">Full-time evidence needs review. The award is blocked; the original deadline is retained.</Notice>}
          {match.award ? <View style={s.stack}><Pill>{match.award.result === 'no_valid_votes' ? 'No valid votes received' : match.award.winnerLabels.length > 1 ? 'Joint players’ players of the match' : 'Players’ player of the match'}</Pill>{match.award.winnerLabels.map(label => <Text key={label} style={s.winner}>{label}</Text>)}{match.award.deadlineMissed && <Notice tone="warning">Finalisation was late. The original full-time deadline has not been extended.</Notice>}<Text style={s.muted}>Finalised {dateTime(match.award.finalisedAtMs)}. This sealed result does not reopen when a report is edited.</Text></View> : <>
            {match.cutoffSource === 'unresolved' && <Notice tone="warning">Q15 is still open: +59 minutes is a proposal. A manager can set a deliberate fictional cutoff below or close voting after full time. No automatic production cutoff is accepted here.</Notice>}
            {actor.role === 'manager' && match.fullTimeAtMs !== null && match.finishQuality === 'trusted' && <>
              {match.cutoffSource === 'unresolved' && <><TextInput style={s.input} keyboardType="numeric" value={cutoffMinutes[match.id] ?? ''} onChangeText={value => setCutoffMinutes(previous => ({ ...previous, [match.id]: value }))} placeholder="Explicit demo cutoff: 1–59 minutes after full time" placeholderTextColor={colors.inkMuted} accessibilityLabel="Fictional ballot cutoff minutes" /><Button label="Set this fictional ballot cutoff" testID="community-configure-cutoff" variant="secondary" disabled={busy || !cutoffMinutes[match.id]?.trim()} onPress={() => void run({ type: 'award.cutoffConfigured', matchId: match.id, minutesAfterFullTime: Number(cutoffMinutes[match.id]) })} /></>}
              <Button label="Close voting and finalise award" testID="community-finalise-award" disabled={busy} onPress={() => setCloseAward(match.id)} />
              <Text style={s.muted}>Managers cannot inspect choices or cast a player’s ballot.</Text>
            </>}
            {actor.role === 'player' && <>
              {match.ownChoice && <Text style={s.label}>Your saved choice: {match.ownChoice.replace('synthetic-player-', 'Player ')}</Text>}
              {match.mayVote ? <><Text style={s.label}>Choose a teammate who played</Text>{match.candidates.map(candidate => <Pressable key={candidate.id} accessibilityRole="radio" accessibilityState={{ checked: (choices[match.id] ?? match.ownChoice) === candidate.id }} style={[s.choice, (choices[match.id] ?? match.ownChoice) === candidate.id && s.choiceSelected]} onPress={() => setChoices(previous => ({ ...previous, [match.id]: candidate.id }))}><Text style={s.body}>{candidate.label}</Text></Pressable>)}<Button label={match.ownChoice ? 'Confirm changed private choice' : 'Confirm private choice'} testID="community-cast-ballot" disabled={busy || !(choices[match.id] ?? match.ownChoice)} onPress={() => void run({ type: 'ballot.cast', matchId: match.id, candidatePlayerId: (choices[match.id] ?? match.ownChoice)! })} /><Text style={s.muted}>Saved in this fictional rehearsal only. A connected service must acknowledge a live ballot before it counts.</Text></> : <Text style={s.muted}>Voting is unavailable: the window is closed, the cutoff needs configuration, or this player is not eligible.</Text>}
            </>}
          </>}
        </>}
      </Card>)}
    </View>}
    {view.allowed && included('photos') && <View style={s.stack}>
      <Text style={s.heading}>Game albums</Text>
      <Notice>Fictional media rehearsal: original vector illustrations only. Real device picking, upload processing and safety scanning are not connected. No real children’s photos are used.</Notice>
      <Text style={s.label}>{view.gallery.length} published {view.gallery.length === 1 ? 'illustration' : 'illustrations'}</Text>
      {!view.gallery.length && <Card><Text style={s.body}>No published photos available to this account.</Text><Text style={s.muted}>Grant expiry, competition policy and hidden uploaders are checked for each item.</Text></Card>}
      {view.gallery.map(photo => <Card key={photo.id}><Pressable accessibilityRole="button" accessibilityLabel={`Open ${photo.caption || 'published illustration'}`} onPress={() => setViewerId(photo.id)}><FictionalImage art={photo.art} /></Pressable><Text style={s.label}>{photo.matchLabel}</Text><Text style={s.muted}>{dateTime(photo.playedAtMs)} · {photo.uploaderLabel}</Text><Text style={s.body}>{photo.caption}</Text><Button label="Open illustration and safety actions" variant="secondary" onPress={() => setViewerId(photo.id)} /></Card>)}
      {actor.role !== 'spectator' && <Card>
        <Text style={s.heading}>Prepare a submission</Text>
        <Text style={s.muted}>Use the first fictional completed match. Players submit for review; managers prepare a draft and publish it explicitly.</Text>
        <View style={s.wrap}>{(['pitch', 'ball', 'cones'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`Choose ${value} illustration`} accessibilityState={{ checked: art === value }} onPress={() => setArt(value)} style={[s.artOption, art === value && s.choiceSelected]}><FictionalImage art={value} small /><Text style={s.label}>{value}</Text></Pressable>)}</View>
        <TextInput style={s.input} value={caption} onChangeText={setCaption} maxLength={160} placeholder="Optional caption · no personal details" placeholderTextColor={colors.inkMuted} accessibilityLabel="Illustration caption" />
        <View style={s.settingRow}><Text style={[s.body, { flex: 1 }]}>I reviewed this illustration and the content rules.</Text><Switch accessibilityLabel="Content policy reviewed" value={policyAcknowledged} onValueChange={setPolicyAcknowledged} /></View>
        <Button label={actor.role === 'manager' ? 'Save unpublished manager draft' : 'Submit illustration for approval'} testID="community-submit-photo" disabled={busy || !policyAcknowledged || !view.matches.length} onPress={() => void run({ type: 'photo.submitted', photoId: randomUUID(), matchId: view.matches[0].id, art, caption, policyAcknowledged: true })} />
      </Card>}
      {actor.role !== 'spectator' && <Card><Text style={s.heading}>My submissions</Text>
        {!view.submissions.length && <Text style={s.body}>No submissions yet.</Text>}
        {view.submissions.map(photo => <View key={photo.id} style={s.submission}><Pill tone={photo.status === 'published' ? 'brand' : 'muted'}>{photo.status} · revision {photo.version}</Pill>{photo.art && <FictionalImage art={photo.art} small />}<Text style={s.body}>{photo.caption}</Text>{photo.rejectionReason && <Notice tone="warning">Private review reason: {photo.rejectionReason}</Notice>}{photo.previousPublishedVersion !== null && <Text style={s.muted}>The previous approved revision {photo.previousPublishedVersion} remains in the gallery until replacement approval.</Text>}
          {photo.status === 'draft' && actor.role === 'manager' && <Button label="Publish this manager illustration" testID="community-publish-photo" disabled={busy} onPress={() => void run({ type: 'photo.published', photoId: photo.id, sourceRevision: photo.version, policyAcknowledged: true })} />}
          {(photo.status === 'draft' || photo.status === 'pending') && <Button label="Withdraw this unpublished revision" variant="secondary" disabled={busy} onPress={() => void run({ type: 'photo.withdrawn', photoId: photo.id, sourceRevision: photo.version })} />}
          {photo.status !== 'removed' && <Button label="Submit a revised caption and selected illustration" variant="secondary" disabled={busy || !policyAcknowledged} onPress={() => void run({ type: 'photo.revised', photoId: photo.id, sourceRevision: photo.version, art, caption, policyAcknowledged: true })} />}
        </View>)}
      </Card>}
      {actor.role === 'manager' && <Card><Text style={s.heading}>Private player-photo review</Text>
        {!view.reviewQueue.length && <Text style={s.body}>No pending player illustrations to review.</Text>}
        {view.reviewQueue.map(photo => <View key={photo.id} style={s.submission}><FictionalImage art={photo.art} small /><Text style={s.label}>{photo.uploaderLabel} · revision {photo.version}</Text><Text style={s.body}>{photo.caption}</Text><Button label={`Approve ${photo.uploaderLabel} revision ${photo.version}`} testID="community-approve-photo" disabled={busy} onPress={() => void run({ type: 'photo.reviewed', photoId: photo.id, sourceRevision: photo.version, decision: 'approve' })} /><TextInput style={s.input} value={rejectionReasons[photo.id] ?? ''} onChangeText={value => setRejectionReasons(previous => ({ ...previous, [photo.id]: value }))} placeholder="Private rejection reason" placeholderTextColor={colors.inkMuted} accessibilityLabel={`Private rejection reason for ${photo.uploaderLabel}`} maxLength={240} /><Button label="Reject with this private reason" variant="danger" disabled={busy || !rejectionReasons[photo.id]?.trim()} onPress={() => void run({ type: 'photo.reviewed', photoId: photo.id, sourceRevision: photo.version, decision: 'reject', reason: rejectionReasons[photo.id] })} /></View>)}
      </Card>}
      {actor.role === 'manager' && view.reviewConcerns.length > 0 && <Card><Text style={s.heading}>Content concerns</Text>{view.reviewConcerns.map(concern => <View key={concern.id} style={s.submission}><Text style={s.label}>{concern.category} · {concern.status.replaceAll('_', ' ')}</Text><Text style={s.body}>{concern.explanation || 'No additional explanation.'}</Text><Text style={s.muted}>Reference {concern.id}. Reporter identity is withheld.</Text>{concern.status !== 'resolved' && <><Button label="Mark under review" variant="secondary" disabled={busy} onPress={() => void run({ type: 'concern.updated', concernId: concern.id, status: 'under_review' })} /><Button label="Record concern resolved" variant="secondary" disabled={busy} onPress={() => void run({ type: 'concern.updated', concernId: concern.id, status: 'resolved' })} /></>}</View>)}</Card>}
    </View>}
    {included('account') && personalAccount}
    <Modal visible={Boolean(viewer)} transparent animationType="fade" onRequestClose={() => setViewerId(null)}>
      <View style={s.overlay}><DialogSheet>
        <Button label="Close illustration" variant="quiet" onPress={() => setViewerId(null)} />
        {viewer && <><FictionalImage art={viewer.art} /><Text style={s.label}>{viewer.matchLabel}</Text><Text style={s.body}>{viewer.caption}</Text><Text style={s.muted}>{viewer.uploaderLabel} · published revision {viewer.version}</Text>
          <Button label="Report this illustration" variant="secondary" onPress={() => { setReportTarget({ type: 'photo', id: viewer.id }); setViewerId(null); }} />
          <Button label="Report this uploader" variant="secondary" onPress={() => { setReportTarget({ type: 'uploader', id: viewer.uploaderAccountId }); setViewerId(null); }} />
          {viewer.uploaderAccountId !== actor.accountId && <Button label="Hide this uploader from my gallery" variant="secondary" onPress={() => { setHideConfirmation({ id: viewer.uploaderAccountId, label: viewer.uploaderLabel }); setViewerId(null); }} />}
          {actor.role === 'manager' && <Button label="Remove this published illustration" variant="danger" disabled={busy} onPress={() => void run({ type: 'photo.removed', photoId: viewer.id })} />}
        </>}
      </DialogSheet></View>
    </Modal>
    <Modal visible={reportTarget !== null} transparent animationType="fade" onRequestClose={() => setReportTarget(null)}>
      <View style={s.overlay}><DialogSheet>
        <Text style={s.heading}>Report {reportTarget?.type === 'photo' ? 'illustration' : 'uploader'}</Text>
        <Text style={s.body}>Choose a concern category. Avoid adding unnecessary personal details. Reporting and hiding are separate actions.</Text>
        {(['privacy', 'inappropriate', 'other'] as const).map(category => <Pressable key={category} style={[s.choice, reportCategory === category && s.choiceSelected]} accessibilityRole="radio" accessibilityState={{ checked: reportCategory === category }} onPress={() => setReportCategory(category)}><Text style={s.body}>{category}</Text></Pressable>)}
        <TextInput style={s.input} multiline value={reportExplanation} onChangeText={setReportExplanation} maxLength={500} placeholder="Optional explanation" placeholderTextColor={colors.inkMuted} accessibilityLabel="Concern explanation" />
        <Button label="Save concern in fictional review" testID="community-report-concern" disabled={busy} onPress={() => { if (reportTarget) void run({ type: 'concern.submitted', concernId: randomUUID(), targetType: reportTarget.type, targetId: reportTarget.id, category: reportCategory, explanation: reportExplanation }).then(ok => { if (ok) { setReportTarget(null); setReportExplanation(''); } }); }} />
        <Text style={s.muted}>A live submission needs a connected service acknowledgement. This rehearsal does not contact an operator.</Text>
        <Button label="Cancel concern" variant="quiet" onPress={() => setReportTarget(null)} />
      </DialogSheet></View>
    </Modal>
    <Modal visible={hideConfirmation !== null} transparent animationType="fade" onRequestClose={() => setHideConfirmation(null)}><View style={s.overlay}><DialogSheet><Text style={s.heading}>Hide {hideConfirmation?.label}?</Text><Text style={s.body}>Their photos will be hidden from your gallery. Official match records stay visible according to your permissions. Moderation work is unaffected.</Text><Button label="Confirm gallery-only hide" disabled={busy} onPress={() => { if (hideConfirmation) void run({ type: 'uploader.hidden', uploaderAccountId: hideConfirmation.id, hidden: true }).then(ok => { if (ok) setHideConfirmation(null); }); }} /><Button label="Cancel hide" variant="quiet" onPress={() => setHideConfirmation(null)} /></DialogSheet></View></Modal>
    <Modal visible={closeAward !== null} transparent animationType="fade" onRequestClose={() => setCloseAward(null)}><View style={s.overlay}><DialogSheet><Text style={s.heading}>Close this ballot?</Text><Text style={s.body}>Seal the latest valid private choices now and record a winner, joint winners or no valid votes. This cannot reopen voting or move the original +60-minute result deadline.</Text><Button label="Confirm close and finalise" disabled={busy} onPress={() => { if (closeAward) void run({ type: 'award.finalised', matchId: closeAward }).then(ok => { if (ok) setCloseAward(null); }); }} /><Button label="Keep ballot unchanged" variant="quiet" onPress={() => setCloseAward(null)} /></DialogSheet></View></Modal>
    <Modal visible={deleteConfirmation} transparent animationType="fade" onRequestClose={() => setDeleteConfirmation(false)}><View style={s.overlay}><DialogSheet><Text style={s.heading}>Prepare global deletion for {view.accountLabel}?</Text><Text style={s.body}>This concerns every membership on this global account. A verified live service must review retention and any active controller or unsynchronised journal before acting. This button saves a verification-needed draft only.</Text><Button label="Save verification-needed deletion draft" variant="danger" disabled={busy} onPress={() => void run({ type: 'privacy.drafted', requestId: randomUUID(), requestType: 'delete_global_account' }).then(ok => { if (ok) setDeleteConfirmation(false); })} /><Button label="Cancel deletion draft" variant="quiet" onPress={() => setDeleteConfirmation(false)} /></DialogSheet></View></Modal>
  </View>;
}

const s = StyleSheet.create({
  stack: { gap: 14 }, heading: { color: colors.ink, fontSize: 21, lineHeight: 28, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  body: { color: colors.ink, fontSize: 16, lineHeight: 24 }, muted: { color: colors.inkMuted, fontSize: 14, lineHeight: 21 },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 8, backgroundColor: colors.surface, padding: 12, color: colors.ink, fontSize: 16 },
  settingRow: { minHeight: 52, gap: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  choice: { minHeight: 52, borderWidth: 2, borderColor: colors.border, borderRadius: 8, padding: 12, justifyContent: 'center' },
  choiceSelected: { borderColor: colors.brand, backgroundColor: '#E4F1E9' },
  art: { borderRadius: 8, backgroundColor: colors.bench, overflow: 'hidden' }, artLabel: { fontSize: 10, lineHeight: 16, letterSpacing: 1, textAlign: 'center', color: colors.inkMuted, padding: 4 },
  artOption: { flexGrow: 1, flexBasis: 130, minHeight: 140, maxWidth: 240, borderWidth: 2, borderColor: colors.border, borderRadius: 8, padding: 6, gap: 6 },
  wrap: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  inviteRow: { paddingTop: 12, borderTopWidth: 1, borderColor: colors.border, gap: 10 },
  submission: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 14, gap: 10 },
  winner: { color: colors.brand, fontSize: 24, lineHeight: 32, fontWeight: '700' },
  overlay: { flex: 1, padding: 16, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(20,37,29,0.65)' },
  sheet: { width: '100%', maxWidth: 560, maxHeight: '96%', flexGrow: 0, borderRadius: 12, backgroundColor: colors.surface },
  sheetContent: { padding: 16, gap: 12 },
  code: { color: colors.inkMuted, fontFamily: 'monospace', fontSize: 11, lineHeight: 17 },
});
