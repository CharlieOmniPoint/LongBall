import { formatUkDate, formatUkDateTime } from '@longball/application/uk-display';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import type { Role } from '@longball/application/access';
import { startForegroundRefresh } from '@longball/application/foreground-refresh';
import type { ReportExportRequest, ReportExportStatus } from '@longball/application/report-export';
import type { ReportExportJobPort } from '../platform/report-export-jobs';
import { randomUUID } from '../platform/id';
import { Button, Card, Notice, Pill, typography } from '../ui';

type Kind = ReportExportRequest['kind'];
interface Attempt { request: ReportExportRequest; projectionVersion: number; key: string; port: ReportExportJobPort }
const labels: Record<Kind, string> = { season_results: 'Season report', match_summary: 'Match report', own_participation: 'My participation', team_participation: 'Team participation', attendance: 'Attendance' };
const statusLabels = { queued: 'Queued', working: 'Preparing report', ready: 'Ready to download', failed: 'Could not prepare report', expired: 'Export expired' };
const foregroundNow = () => Platform.OS === 'web' ? typeof document !== 'undefined' && document.visibilityState !== 'hidden' : AppState.currentState === 'active';
const when = formatUkDateTime;
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The export request could not complete.';

/** A queued job never downloads automatically. The original request/key survive an uncertain response. */
export function ReportExportPanel(props: {
  teamId: string; seasonId: string; audience: Role; projectionVersion: number;
  matches: readonly { matchId: string; opponent: string | null; playedDate: string | null; suppressionReason?: string | null }[];
  disabled: boolean; active?: boolean;
  openJobs: () => ReportExportJobPort;
  onLegacyJson: (request: { kind: 'season' | 'match'; format: 'json'; matchId?: string; expectedProjectionVersion: number }, signal: AbortSignal) => Promise<string>;
}) {
  const [kind, setKind] = useState<Kind>('season_results'), [matchId, setMatchId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [status, setStatus] = useState<ReportExportStatus | null>(null);
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<string | null>(null), [paused, setPaused] = useState(false);
  const [foreground, setForeground] = useState(foregroundNow);
  const mounted = useRef(true), lock = useRef(false), action = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const changed = () => setForeground(foregroundNow());
    const subscription = AppState.addEventListener('change', changed);
    if (Platform.OS === 'web' && typeof document !== 'undefined') document.addEventListener('visibilitychange', changed);
    return () => {
      mounted.current = false; action.current?.abort(); subscription.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined') document.removeEventListener('visibilitychange', changed);
    };
  }, []);
  useEffect(() => { if (props.active === false || !foreground) action.current?.abort(); }, [props.active, foreground]);
  const exportId = status?.id, exportState = status?.status;
  useEffect(() => {
    if (!attempt || !exportId || !exportState || !['queued', 'working'].includes(exportState) || paused || busy || props.active === false || !foreground) return;
    const refresh = startForegroundRefresh({
      read: async signal => {
        const next = await attempt.port.read(exportId, signal);
        if (!signal.aborted && mounted.current) { setStatus(next); setFeedback(null); }
      },
      onFailure: cause => { if (mounted.current) setFeedback(`Status check delayed. ${message(cause)}`); return 'retry'; },
    });
    return () => refresh.stop();
  }, [attempt, exportId, exportState, paused, busy, props.active, foreground]);
  const perform = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (lock.current || props.disabled || props.active === false || !foreground) return;
    lock.current = true; setBusy(true); setFeedback(null);
    const controller = new AbortController(); action.current = controller;
    try { await task(controller.signal); }
    catch (cause) { if (mounted.current && !controller.signal.aborted) setFeedback(message(cause)); }
    finally { if (action.current === controller) action.current = null; lock.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = (captured: Attempt) => perform(async signal => {
    const result = await captured.port.create(captured.request, captured.projectionVersion, captured.key, signal);
    if (!signal.aborted && mounted.current) setStatus(result);
  });
  const prepare = (format: 'csv' | 'pdf') => {
    if (lock.current) return;
    try {
      const captured: Attempt = { request: { kind, teamId: props.teamId, seasonId: props.seasonId, ...(kind === 'match_summary' ? { matchId } : {}), format }, projectionVersion: props.projectionVersion, key: randomUUID(), port: props.openJobs() };
      setAttempt(captured); setStatus(null); setPaused(false); void submit(captured);
    } catch (cause) { setFeedback(message(cause)); }
  };
  const permittedMatches = props.matches.filter(report => !report.suppressionReason);
  const matchMissing = kind === 'match_summary' && !permittedMatches.some(report => report.matchId === matchId);
  const uncertain = Boolean(attempt && !status);
  const disabled = props.disabled || busy || props.active === false || !foreground;
  const kinds: Kind[] = ['season_results', 'match_summary', ...(props.audience === 'manager' ? ['team_participation', 'attendance'] as Kind[] : props.audience === 'player' ? ['own_participation', 'attendance'] as Kind[] : [])];
  return <Card>
    <View style={{ gap: 12 }} testID="records-export-panel">
      <Text accessibilityRole="header" style={typography.section}>Export a permitted report</Text>
      <Text style={typography.body}>Prepare a CSV or PDF, then download it when ready. Access, report version and sharing policy are checked again before delivery. A copy you save outside LongBall is separate.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {kinds.map(choice => <Button key={choice} label={labels[choice]} variant={kind === choice ? 'primary' : 'secondary'} disabled={disabled || uncertain} onPress={() => setKind(choice)} />)}
      </View>
      {kind === 'match_summary' && permittedMatches.map(report => <Button key={report.matchId} label={`${report.opponent ?? 'Team match'} · ${report.playedDate ? formatUkDate(report.playedDate) : 'Date not recorded'}`} variant={matchId === report.matchId ? 'primary' : 'secondary'} disabled={disabled || uncertain} onPress={() => setMatchId(report.matchId)} />)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button label="Export permitted JSON" testID="records-export-json" variant="secondary" disabled={disabled || uncertain || matchMissing || !['season_results', 'match_summary'].includes(kind)} onPress={() => { void perform(async signal => { const result = await props.onLegacyJson({ kind: kind === 'match_summary' ? 'match' : 'season', format: 'json', ...(kind === 'match_summary' && matchId ? { matchId } : {}), expectedProjectionVersion: props.projectionVersion }, signal); if (!signal.aborted && mounted.current) setFeedback(result); }); }} />
        <Button label="Prepare permitted CSV" testID="records-export-csv" disabled={disabled || uncertain || matchMissing} onPress={() => prepare('csv')} />
        <Button label="Prepare permitted PDF" testID="records-export-pdf" variant="secondary" disabled={disabled || uncertain || matchMissing} onPress={() => prepare('pdf')} />
      </View>
      {!['season_results', 'match_summary'].includes(kind) && <Text style={typography.muted}>JSON remains available for season and match summaries. Choose CSV or PDF for this report.</Text>}
      {attempt && <View style={{ gap: 10 }} testID="records-export-job">
        <Text style={typography.label}>{labels[attempt.request.kind]} · {attempt.request.format.toUpperCase()}</Text>
        {status ? <>
          <Pill tone={status.status === 'ready' ? 'brand' : status.status === 'failed' || status.status === 'expired' ? 'warning' : 'info'}>{statusLabels[status.status]}</Pill>
          <Text selectable style={typography.muted}>Reference {status.id}</Text>
          {status.generatedAt && <Text style={typography.muted}>Prepared {when(status.generatedAt)} Europe/London.</Text>}
          {status.expiresAt && <Text style={typography.muted}>Expires {when(status.expiresAt)} Europe/London.</Text>}
          {status.status === 'ready' && <Button label={`Download prepared ${attempt.request.format.toUpperCase()}`} testID="records-export-download" disabled={disabled} onPress={() => { void perform(async signal => { const result = await attempt.port.download(status.id, attempt.request.format, signal); if (!signal.aborted && mounted.current) setFeedback(result); }); }} />}
          {['queued', 'working'].includes(status.status) && <Button label={paused ? 'Resume export status checks' : 'Pause export status checks'} variant="quiet" disabled={disabled} onPress={() => setPaused(value => !value)} />}
          {!['expired', 'failed'].includes(status.status) && <Button label="Check export status" testID="records-export-status" variant="secondary" disabled={disabled} onPress={() => { void perform(async signal => { const next = await attempt.port.read(status.id, signal); if (!signal.aborted && mounted.current) setStatus(next); }); }} />}
          {status.status === 'failed' && <Notice tone="warning">This report could not be prepared. Refresh your reports and prepare a new export. No file was downloaded.</Notice>}
          {status.status === 'expired' && <Notice>This prepared file expired. Prepare a new export with current report permissions.</Notice>}
        </> : <>
          <Notice>{busy ? 'Requesting preparation. No file has been downloaded.' : 'The service response is unconfirmed. Retry this same request before preparing another export.'}</Notice>
          <Button label="Retry original export request" testID="records-export-retry" variant="secondary" disabled={disabled} onPress={() => { void submit(attempt); }} />
        </>}
        <Button label="Close this export request" variant="quiet" disabled={disabled} onPress={() => { setAttempt(null); setStatus(null); setPaused(false); setFeedback('Local tracking closed. A submitted job may still finish on the service; no file is downloaded automatically.'); }} />
      </View>}
      {feedback && <Notice>{feedback}</Notice>}
    </View>
  </Card>;
}
