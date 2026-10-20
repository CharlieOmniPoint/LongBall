import { StyleSheet } from 'react-native';

/** The supplied visual tokens, shared by the native and browser review surfaces. */
export const colors = {
  canvas: '#F6F8F7',
  surface: '#FFFFFF',
  ink: '#14251D',
  inkMuted: '#526459',
  brand: '#126946',
  brandPressed: '#0D4F35',
  pitch: '#176B45',
  pitchAlternate: '#1B754D',
  pitchLine: '#FFFFFF',
  border: '#CAD5CE',
  controlBorder: '#526459',
  focus: '#145BCD',
  warningInk: '#7B4900',
  warningSurface: '#FFF2D4',
  errorInk: '#A32622',
  errorSurface: '#FFF0EF',
  infoInk: '#194E7A',
  infoSurface: '#EDF5FC',
  disc: '#FFFFFF',
  discInk: '#14251D',
  selection: '#FFDB70',
  bench: '#E7ECE9',
} as const;

export const typography = StyleSheet.create({
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700', color: colors.ink },
  section: { fontSize: 20, lineHeight: 26, fontWeight: '600', color: colors.ink },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 14, lineHeight: 20, color: colors.inkMuted },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.ink },
  clock: { fontSize: 40, lineHeight: 44, fontWeight: '700', fontVariant: ['tabular-nums'], color: colors.ink },
  score: { fontSize: 32, lineHeight: 36, fontWeight: '700', fontVariant: ['tabular-nums'], color: colors.ink },
});
