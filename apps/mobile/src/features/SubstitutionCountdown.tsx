import { Text, View } from 'react-native';
import { substitutionCountdownLabel } from '@longball/application/substitution-alerts';
import { colors, typography } from '../ui/tokens';

export interface SubstitutionCountdownSnapshot {
  dueInMs: number | null;
  state: 'running' | 'paused' | 'half_time' | 'waiting' | 'unavailable';
  outgoing: string[];
  incoming: string[];
}
/** Read-only: elapsed time and suggested names never record a substitution. */
export function SubstitutionCountdown({ value, compact = false }: { value: SubstitutionCountdownSnapshot; compact?: boolean }) {
  const display = substitutionCountdownLabel(value.dueInMs, value.state);
  const due = value.dueInMs !== null && value.dueInMs <= 0;
  return <View testID="next-substitution-countdown" style={{ gap: compact ? 2 : 6, padding: compact ? 8 : 12, borderRadius: 10, borderWidth: 1, borderColor: due ? colors.warningInk : colors.border, backgroundColor: colors.surface }}>
    <View style={{ flexDirection: compact ? 'column' : 'row', justifyContent: 'space-between', alignItems: compact ? 'flex-start' : 'center', gap: compact ? 2 : 8, flexWrap: 'wrap' }}>
      <Text style={typography.label}>{display.label}</Text>
      {display.time !== null && <Text testID="next-substitution-time" style={{ ...typography.section, fontSize: compact ? 24 : 36, lineHeight: compact ? 28 : 42, fontVariant: ['tabular-nums'], color: due ? colors.warningInk : colors.ink }}>{display.time}</Text>}
    </View>
    {!compact && !!value.outgoing.length && <Text numberOfLines={compact ? 1 : undefined} style={typography.muted}>Off: {value.outgoing.join(', ')}</Text>}
    {!compact && !!value.incoming.length && <Text numberOfLines={compact ? 1 : undefined} style={typography.muted}>On: {value.incoming.join(', ')}</Text>}
    {!compact && display.time !== null && <Text style={typography.muted}>Suggested change only · confirm when players actually change.</Text>}
  </View>;
}
