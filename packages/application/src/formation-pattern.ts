import type { FormationSlot, PreparationFormation } from './preparation';

export const TRADITIONAL_FORMATIONS: Readonly<Record<number, readonly string[]>> = {
  5: ['2-1-1', '1-2-1', '2-2', '1-1-2'],
  6: ['2-2-1', '2-1-2', '1-3-1', '3-1-1'],
  7: ['2-3-1', '3-2-1', '2-2-2', '1-3-2'],
  8: ['3-3-1', '2-3-2', '3-2-2', '2-4-1'],
  9: ['3-3-2', '2-4-2', '3-2-3', '4-3-1'],
  10: ['3-4-2', '4-3-2', '3-3-3', '4-4-1'],
  11: ['4-4-2', '4-3-3', '3-5-2', '4-2-3-1', '3-4-3', '4-1-4-1', '5-3-2'],
};
/** Traditional notation omits the one goalkeeper and reads defence towards attack. */
export function parseFormationPattern(source: string, pitchPlaces: number): number[] {
  if (!Number.isInteger(pitchPlaces) || pitchPlaces < 5 || pitchPlaces > 11)
    throw new Error('Choose between 5 and 11 players a side, including one goalkeeper.');
  if (typeof source !== 'string' || source.length > 32)
    throw new Error('Enter a formation such as 4-4-2 or 3-2-1.');
  const normal = source.trim().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, '');
  if (!/^[1-9](?:-[1-9]){1,4}$/.test(normal))
    throw new Error('Use 2 to 5 lines of outfield players separated by hyphens, such as 4-4-2. Do not include the goalkeeper.');
  const bands = normal.split('-').map(Number);
  const outfield = bands.reduce((sum, count) => sum + count, 0);
  if (outfield !== pitchPlaces - 1)
    throw new Error(`The numbers must total ${pitchPlaces - 1} outfield players for ${pitchPlaces}-a-side. One goalkeeper is added automatically.`);
  return bands;
}

function bandPositions(count: number, band: number, totalBands: number): string[] {
  if (band === 0) {
    if (count >= 4) return ['LB', ...Array<string>(count - 2).fill('CB'), 'RB'];
    return Array<string>(count).fill('CB');
  }
  if (band === totalBands - 1) {
    if (count >= 3) return ['LW', ...Array<string>(count - 2).fill('ST'), 'RW'];
    return Array<string>(count).fill('ST');
  }
  if (count >= 3) return ['LW', ...Array<string>(count - 2).fill('CM'), 'RW'];
  return Array<string>(count).fill('CM');
}

export function formationFromPattern(input: {
  pattern: string;
  format: number;
  id: string;
  name?: string;
  activePositions?: readonly string[];
}): Omit<PreparationFormation, 'version'> {
  const bands = parseFormationPattern(input.pattern, input.format);
  const pattern = bands.join('-');
  const slots: FormationSlot[] = [{ id: 'gk-1', label: 'GK', position: 'GK', x: 0.5, y: 0.91 }];
  for (const [row, count] of bands.entries()) {
    const positions = bandPositions(count, row, bands.length);
    for (const [column, position] of positions.entries()) {
      slots.push({
        id: `line-${row + 1}-${column + 1}`,
        label: position,
        position,
        x: (column + 1) / (count + 1),
        y: 0.73 - (row / (bands.length - 1)) * 0.59,
      });
    }
  }
  if (input.activePositions) {
    const inactive = [...new Set(slots.filter(slot => !input.activePositions!.includes(slot.position)).map(slot => slot.position))];
    if (inactive.length) throw new Error(`Activate ${inactive.join(', ')} in Team positions, or choose another formation before saving.`);
  }
  return { id: input.id, name: input.name?.trim() || pattern, format: input.format, slots };
}

/** Existing free-position templates can still be opened; only aligned rows yield traditional notation. */
export function patternFromFormation(formation: Pick<PreparationFormation, 'slots' | 'format'>): string | null {
  if (formation.slots.length !== formation.format || formation.slots.filter(slot => slot.position === 'GK').length !== 1) return null;
  const rows = new Map<number, number>();
  for (const slot of formation.slots.filter(slot => slot.position !== 'GK')) {
    const row = Math.round(slot.y * 1000);
    rows.set(row, (rows.get(row) ?? 0) + 1);
  }
  const pattern = [...rows].sort((a, b) => b[0] - a[0]).map(([, count]) => count).join('-');
  try { parseFormationPattern(pattern, formation.format); return pattern; }
  catch { return null; }
}
