import { useState } from 'react';
import { Text, View } from 'react-native';
import { selectTeamOverviewGame, teamOverviewLondonDate, teamOverviewStatusLabel, type TeamOverviewGame } from '@longball/application/team-overview';
import { formatUkDate, formatUkSeasonLabel } from '@longball/application/uk-display';
import { Button, Card, Notice, Pill, typography } from '../ui';

export interface TeamOverviewProps {
  team: { name: string; ageGroup?: string; clubName?: string; seasonLabel?: string };
  games: readonly TeamOverviewGame[];
  nowMs?: number;
  busy?: boolean;
  onOpenGame: (id: string) => void;
  onRefresh?: () => void;
}
/** Safe team/game overview for every authorised role; accepts no private player records. */
export function TeamOverview({ team, games, nowMs, busy = false, onOpenGame, onRefresh }: TeamOverviewProps) {
  const [openedAt] = useState(() => Date.now());
  const selected = selectTeamOverviewGame(games, teamOverviewLondonDate(nowMs ?? openedAt)), game = selected.game;
  const title = [team.name, team.ageGroup].filter(Boolean).join(' ');
  const date = game ? formatUkDate(game.playedDate) : null;
  const kickoff = game?.kickoff && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.kickoff) ? game.kickoff : 'Time to be confirmed';
  return <View style={{ gap: 14 }} testID="team-overview">
    <Card>
      <Text style={typography.muted}>{team.clubName ?? 'Your team'}</Text>
      <Text accessibilityRole="header" style={typography.title}>{title}</Text>
      {team.seasonLabel && <Text style={typography.body}>Season {formatUkSeasonLabel(team.seasonLabel)}</Text>}
    </Card>
    {selected.notice && <Notice tone="warning">{selected.notice}</Notice>}
    {game ? <Card>
      <Pill>{selected.reason === 'active_today' ? 'Today’s saved game' : selected.reason === 'scheduled_today' ? 'Scheduled today' : 'Next fixture'}</Pill>
      <Text accessibilityRole="header" style={typography.section}>{title} v {game.opponent}</Text>
      <Text style={typography.body}>{date} · {kickoff}</Text>
      {game.venue && <Text style={typography.muted}>{game.venue}</Text>}
      <Text style={typography.body}>{teamOverviewStatusLabel(game)}</Text>
      {selected.reason === 'active_today' && <Text style={typography.muted}>Status reflects the latest saved update. Open the game for current details.</Text>}
      <Button label="Open game" testID="team-overview-open-game" disabled={busy} onPress={() => onOpenGame(game.id)} />
    </Card> : <Card><Text style={typography.section}>No upcoming game listed</Text><Text style={typography.muted}>A future fixture will appear here when its date is recorded.</Text></Card>}
    {onRefresh && <Button label="Refresh team overview" variant="secondary" disabled={busy} onPress={onRefresh} />}
  </View>;
}
