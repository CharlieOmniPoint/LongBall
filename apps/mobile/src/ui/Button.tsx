import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './Icon';
import { colors } from './tokens';

export function Button({ label, accessibilityLabel, onPress, variant = 'primary', icon, disabled = false, testID, style }: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  icon?: IconName;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [focused, setFocused] = useState(false);
  const ink = variant === 'primary' ? colors.surface : variant === 'danger' ? colors.errorInk : colors.brand;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    testID={testID}
    style={({ pressed }) => [
      styles.button,
      variant === 'primary' ? styles.primary : variant === 'danger' ? styles.danger : variant === 'quiet' ? styles.quiet : styles.secondary,
      variant === 'primary' && pressed && { backgroundColor: colors.brandPressed },
      variant !== 'primary' && pressed && { backgroundColor: colors.bench },
      disabled && styles.disabled,
      focused && { borderColor: colors.focus },
      style,
    ]}
  >
    {icon && <Icon name={icon} color={ink} size={21} />}
    <Text style={[styles.buttonText, { color: ink }]}>{label}</Text>
  </Pressable>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Notice({ children, tone = 'info', icon = 'info' }: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'error';
  icon?: IconName;
}) {
  const foreground = tone === 'warning' ? colors.warningInk : tone === 'error' ? colors.errorInk : colors.infoInk;
  const background = tone === 'warning' ? colors.warningSurface : tone === 'error' ? colors.errorSurface : colors.infoSurface;
  return <View style={[styles.notice, { backgroundColor: background }]} accessibilityLiveRegion={tone === 'error' ? 'polite' : 'none'}>
    <View style={{ marginTop: 1 }}><Icon name={icon} color={foreground} size={21} /></View>
    {typeof children === 'string' || typeof children === 'number'
      ? <Text style={[styles.noticeText, { color: foreground }]}>{children}</Text>
      : <View style={{ flex: 1 }}>{children}</View>}
  </View>;
}

export function Pill({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'muted' | 'warning' | 'info' }) {
  const background = tone === 'warning' ? colors.warningSurface : tone === 'info' ? colors.infoSurface : tone === 'muted' ? colors.bench : '#E4F1E9';
  const ink = tone === 'warning' ? colors.warningInk : tone === 'info' ? colors.infoInk : tone === 'muted' ? colors.inkMuted : colors.brand;
  return <View style={[styles.pill, { backgroundColor: background }]}><Text style={[styles.pillText, { color: ink }]}>{children}</Text></View>;
}

const styles = StyleSheet.create({
  button: { minHeight: 52, borderRadius: 8, borderWidth: 2, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  primary: { minHeight: 56, backgroundColor: colors.brand, borderColor: colors.brand },
  secondary: { backgroundColor: colors.surface, borderColor: colors.controlBorder },
  danger: { backgroundColor: colors.errorSurface, borderColor: colors.errorInk },
  quiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
  disabled: { opacity: 0.55 },
  buttonText: { fontSize: 16, lineHeight: 24, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  card: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 12 },
  notice: { borderRadius: 8, padding: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  noticeText: { fontSize: 14, lineHeight: 20, flex: 1 },
  pill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { fontSize: 12, lineHeight: 18, fontWeight: '600' },
});
