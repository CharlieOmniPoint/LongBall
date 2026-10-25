/** Spectator-only PIN rules. A PIN never grants staff or player authority. */
export function spectatorPinProblem(value: string): string | null {
  if (!/^\d{4}$/.test(value)) return "Use exactly four digits.";
  if (new Set(value).size === 1) return "Choose a code with different digits.";
  const digits = [...value].map(Number);
  const steps = digits
    .slice(1)
    .map((digit, index) => (digit - digits[index] + 10) % 10);
  if (steps.every((step) => step === 1) || steps.every((step) => step === 9))
    return "Avoid a sequence such as 1234 or 4321.";
  if (
    value.slice(0, 2) === value.slice(2) ||
    (value[0] === value[1] && value[2] === value[3])
  )
    return "Avoid repeated pairs such as 1212 or 1122.";
  if (
    ["1004", "2000", "2001", "2020", "2580", "0852", "6969", "1313"].includes(
      value,
    )
  )
    return "Choose a less easily guessed code.";
  return null;
}
export function normalizedSpectatorUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username))
    throw new Error(
      "Use a username of 3–40 letters, numbers, dots, underscores or dashes.",
    );
  return username;
}
export interface InviteDirectoryTeam {
  clubId: string;
  clubName: string;
  teamId: string;
  teamName: string;
  ageGroup: string;
  seasonId: string;
  seasonLabel: string;
}
export interface InviteRequestInput {
  requestId: string;
  clubId: string;
  teamId: string;
  seasonId: string;
  requestedRole: "player" | "spectator";
  name: string;
  email: string;
}
export interface InviteRequest extends InviteRequestInput {
  status: "pending" | "handled" | "declined";
  createdAt: string;
}
