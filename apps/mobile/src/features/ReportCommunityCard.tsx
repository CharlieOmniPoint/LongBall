import { Text, View } from 'react-native';
import type { ReportCommunityComposition } from '@longball/application/report-community';
import { Button, Card, Notice, Pill, typography } from '../ui';

/** Only the composed, server-filtered final award and published album reference enter this view. */
export function ReportCommunityCard({ matchId, value, onOpenAlbum, disabled = false }: {
  matchId: string; value?: ReportCommunityComposition | null; onOpenAlbum?: (matchId: string) => void; disabled?: boolean;
}) {
  const compatible = value && (!value.award || value.award.matchId === matchId) && (!value.publishedAlbum || value.publishedAlbum.matchId === matchId);
  if (!compatible || value.communityStatus === 'unavailable') return <Card><Text style={typography.section}>Award and game album</Text><Notice>Award and album information is unavailable in the current service view. Refresh to check the latest permitted records.</Notice></Card>;
  if (value.communityStatus === 'withheld') return <Card><Text style={typography.section}>Award and game album</Text><Notice>Competition policy withholds this match’s award and contextual photos.</Notice></Card>;
  if (value.communityStatus === 'not_recorded') return <Card><Text style={typography.section}>Award and game album</Text><Text style={typography.body}>No award or game album context is recorded. Historical result entry does not create an award or photographs.</Text></Card>;
  const award = value.award, album = value.publishedAlbum;
  return <Card>
    <View style={{ gap: 10 }} testID="report-community-card">
      <Text style={typography.section}>Players’ award</Text>
      {award ? <>
        <Text style={typography.body} testID="report-community-award">{award.result === 'no_valid_votes' ? 'No valid votes' : `${award.winnerLabels.length > 1 ? 'Joint winners' : 'Winner'}: ${award.winnerLabels.join(' · ')}`}</Text>
        <Pill tone={award.deadlineMissed ? 'warning' : 'brand'}>{award.deadlineMissed ? 'Finalised after the original deadline' : 'Final award recorded'}</Pill>
        <Text style={typography.muted}>Finalised {new Date(award.finalisedAtMs).toLocaleString('en-GB', { timeZone: 'Europe/London' })} · original result deadline {new Date(award.finalisationDeadlineAtMs).toLocaleString('en-GB', { timeZone: 'Europe/London' })} Europe/London.</Text>
      </> : <Text style={typography.body}>No final award recorded.</Text>}
      <Text style={typography.section}>Published game album</Text>
      <Text style={typography.body} testID="report-community-album">{album ? `${album.photoCount} published ${album.photoCount === 1 ? 'photo' : 'photos'} visible in this view.` : 'No published album reference recorded.'}</Text>
      {album && onOpenAlbum && <Button label="Open this game album" testID={`report-open-album-${matchId}`} variant="secondary" disabled={disabled} onPress={() => onOpenAlbum(album.matchId)} />}
    </View>
  </Card>;
}
