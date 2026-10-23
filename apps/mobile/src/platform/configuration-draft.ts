export interface ConfigurationFields { clubName: string; teamName: string; ageGroup: string; places: number; minutes: string }
export interface ConfigurationSource extends ConfigurationFields { revision: number }
export type ConfigurationSection = 'club' | 'team';
export interface ConfigurationDraft { source: ConfigurationSource; fields: ConfigurationFields; baseline: ConfigurationFields; clubRevision: number; teamRevision: number }
const keys = { club: ['clubName'], team: ['teamName', 'ageGroup', 'places', 'minutes'] } as const;
const sectionRevision = (section: ConfigurationSection) => section === 'club' ? 'clubRevision' : 'teamRevision';
export function configurationDraft(source: ConfigurationSource): ConfigurationDraft { return { source, fields: { ...source }, baseline: { ...source }, clubRevision: source.revision, teamRevision: source.revision }; }
/** Refresh pristine fields only. A draft keeps its original comparison and CAS revision. */
export function refreshConfigurationDraft(current: ConfigurationDraft, source: ConfigurationSource): ConfigurationDraft {
  const update = <K extends keyof ConfigurationFields>(key: K) => current.fields[key] === current.baseline[key] ? source[key] : current.fields[key];
  const baseline = <K extends keyof ConfigurationFields>(key: K) => current.fields[key] === current.baseline[key] ? source[key] : current.baseline[key];
  const fields = { clubName: update('clubName'), teamName: update('teamName'), ageGroup: update('ageGroup'), places: update('places'), minutes: update('minutes') };
  const original = { clubName: baseline('clubName'), teamName: baseline('teamName'), ageGroup: baseline('ageGroup'), places: baseline('places'), minutes: baseline('minutes') };
  return { source, fields, baseline: original, clubRevision: keys.club.some(key => fields[key] !== original[key]) ? current.clubRevision : source.revision, teamRevision: keys.team.some(key => fields[key] !== original[key]) ? current.teamRevision : source.revision };
}
export function configurationNeedsReview(current: ConfigurationDraft, section: ConfigurationSection): boolean { return current[sectionRevision(section)] !== current.source.revision && keys[section].some(key => current.fields[key] !== current.baseline[key]); }
/** An explicit comparison keeps the user's draft and advances only its reviewed CAS baseline. */
export function reviewConfigurationDraft(current: ConfigurationDraft, section: ConfigurationSection): ConfigurationDraft {
  const baseline = { ...current.baseline };
  for (const key of keys[section]) Object.assign(baseline, { [key]: current.source[key] });
  return { ...current, baseline, [sectionRevision(section)]: current.source.revision };
}
/** Acknowledging one section never saves its sibling. Advance that sibling only if its dirty source is unchanged. */
export function acknowledgeConfigurationDraft(current: ConfigurationDraft, section: ConfigurationSection, submitted: ConfigurationFields): ConfigurationDraft {
  if (keys[section].some(key => current.source[key] !== submitted[key] || current.fields[key] !== submitted[key])) return current;
  const fields = { ...current.fields }, baseline = { ...current.baseline };
  for (const key of keys[section]) { Object.assign(fields, { [key]: current.source[key] }); Object.assign(baseline, { [key]: current.source[key] }); }
  const sibling: ConfigurationSection = section === 'club' ? 'team' : 'club';
  const siblingUnchanged = keys[sibling].every(key => fields[key] === baseline[key] || current.source[key] === baseline[key]);
  return { ...current, fields, baseline, [sectionRevision(section)]: current.source.revision, ...(siblingUnchanged ? { [sectionRevision(sibling)]: current.source.revision } : {}) };
}
