/** A selected role replaces any caller header without case-variant duplicate values. */
export function selectedRoleHeaders(
  initial: HeadersInit | undefined,
  role: string | null,
  currentBindingRole: string | null = null,
): Record<string, string> {
  const headers = new Headers(initial);
  const selected = role ?? currentBindingRole;
  if (selected) headers.set("X-Longball-Role", selected);
  return Object.fromEntries(headers.entries());
}
