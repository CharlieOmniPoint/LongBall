export interface TeamPosition {
  code: string;
  label: string;
  active: boolean;
}
export interface PositionCatalogueSource {
  positionCatalogue?: TeamPosition[];
}
export const CORE_POSITION_CODES = [
  "GK",
  "CB",
  "LB",
  "RB",
  "CM",
  "LW",
  "RW",
  "ST",
] as const;
const labels = [
  "Goalkeeper",
  "Centre back",
  "Left back",
  "Right back",
  "Centre midfield",
  "Left wing",
  "Right wing",
  "Striker",
];
export function defaultPositionCatalogue(): TeamPosition[] {
  return CORE_POSITION_CODES.map((code, index) => ({
    code,
    label: labels[index],
    active: true,
  }));
}
export function validPositionCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}
export function validPositionCatalogue(
  value: unknown,
): value is TeamPosition[] {
  return (
    Array.isArray(value) &&
    value.length >= CORE_POSITION_CODES.length &&
    value.length <= 676 &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        Object.keys(item).length === 3 &&
        validPositionCode(item.code) &&
        typeof item.label === "string" &&
        item.label.trim().length > 0 &&
        item.label.length <= 60 &&
        !/[\u0000-\u001f\u007f]/.test(item.label) &&
        typeof item.active === "boolean",
    ) &&
    new Set(value.map((item) => item.code)).size === value.length &&
    CORE_POSITION_CODES.every((code) =>
      value.some((item) => item.code === code),
    ) &&
    value.some((item) => item.code === "GK" && item.active)
  );
}
/** Legacy preparations inherit the original eight positions; no saved history is rewritten. */
export function positionCatalogueFor(
  source: PositionCatalogueSource,
): TeamPosition[] {
  return (source.positionCatalogue ?? defaultPositionCatalogue()).map(
    (position) => ({ ...position }),
  );
}
export function activePositionCodes(source: PositionCatalogueSource): string[] {
  return positionCatalogueFor(source)
    .filter((item) => item.active)
    .map((item) => item.code);
}
export function saveTeamPosition(
  source: PositionCatalogueSource,
  position: TeamPosition,
): TeamPosition[] {
  if (
    !position ||
    Object.keys(position).length !== 3 ||
    !validPositionCode(position.code) ||
    typeof position.label !== "string" ||
    !position.label.trim() ||
    position.label.length > 60 ||
    /[\u0000-\u001f\u007f]/.test(position.label) ||
    typeof position.active !== "boolean"
  )
    throw new Error(
      "Use a two-letter uppercase position code and a name of up to 60 characters.",
    );
  if (position.code === "GK" && !position.active)
    throw new Error("Goalkeeper must remain active under the match rules.");
  const catalogue = positionCatalogueFor(source);
  const previous = catalogue.findIndex((item) => item.code === position.code);
  const next = { ...position, label: position.label.trim() };
  if (previous < 0) catalogue.push(next);
  else catalogue[previous] = next;
  if (!validPositionCatalogue(catalogue))
    throw new Error(
      "Keep the core position catalogue and one active goalkeeper.",
    );
  return catalogue;
}
export function archiveTeamPosition(
  source: PositionCatalogueSource,
  code: string,
): TeamPosition[] {
  const position = positionCatalogueFor(source).find(
    (item) => item.code === code,
  );
  if (!position) throw new Error("Choose a saved team position.");
  return saveTeamPosition(source, { ...position, active: false });
}
export function assertActiveFormationPositions(
  source: PositionCatalogueSource,
  formation: { slots: { position: string }[] },
): void {
  const active = new Set(activePositionCodes(source));
  if (formation.slots.some((slot) => !active.has(slot.position)))
    throw new Error(
      "Choose active team positions for every formation slot. Inactive positions remain in saved history.",
    );
}
/** Retained inactive profile values can be kept, but never newly assigned. */
export function allowedProfilePosition(
  source: PositionCatalogueSource,
  code: string,
  retained: string[] = [],
): boolean {
  return (
    validPositionCode(code) &&
    positionCatalogueFor(source).some(
      (item) => item.code === code && (item.active || retained.includes(code)),
    )
  );
}
