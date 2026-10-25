import { AccessError } from "./access";
import { spectatorPinProblem } from "./spectator-pin";

/** Rules govern new usernames and newly chosen credentials; existing logins remain valid. */
export interface SignInRules {
  username: { minLength: number; maxLength: number; allowNumbers: boolean; allowSeparators: boolean };
  password: { minLength: number; requireUppercase: boolean; requireLowercase: boolean; requireNumber: boolean; requireSymbol: boolean; disallowUsername: boolean };
  spectatorPin: { blockSimpleCodes: boolean };
}
export interface SignInRulesDto {
  kind: "sign-in-rules";
  revision: number;
  rules: SignInRules;
  provider: { status: "applied" | "not_configured" | "pending"; detail: string };
}
export const DEFAULT_SIGN_IN_RULES: Readonly<SignInRules> = {
  username: { minLength: 3, maxLength: 40, allowNumbers: true, allowSeparators: true },
  password: { minLength: 12, requireUppercase: true, requireLowercase: true, requireNumber: true, requireSymbol: true, disallowUsername: true },
  spectatorPin: { blockSimpleCodes: true },
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function bad(): never { throw new AccessError("INVALID_SIGN_IN_RULES", 400, "Use the documented sign-in rules and supported lengths."); }
export function parseSignInRules(value: unknown): SignInRules {
  if (!exact(value, ["username", "password", "spectatorPin"]) ||
      !exact(value.username, ["minLength", "maxLength", "allowNumbers", "allowSeparators"]) ||
      !exact(value.password, ["minLength", "requireUppercase", "requireLowercase", "requireNumber", "requireSymbol", "disallowUsername"]) ||
      !exact(value.spectatorPin, ["blockSimpleCodes"])) bad();
  const u = value.username, p = value.password, pin = value.spectatorPin;
  if (!Number.isInteger(u.minLength) || Number(u.minLength) < 3 || Number(u.minLength) > 32 ||
      !Number.isInteger(u.maxLength) || Number(u.maxLength) < Math.max(8, Number(u.minLength)) || Number(u.maxLength) > 40 ||
      !Number.isInteger(p.minLength) || Number(p.minLength) < 8 || Number(p.minLength) > 64 ||
      typeof u.allowNumbers !== "boolean" || typeof u.allowSeparators !== "boolean" ||
      [p.requireUppercase,p.requireLowercase,p.requireNumber,p.requireSymbol,p.disallowUsername,pin.blockSimpleCodes].some(v => typeof v !== "boolean")) bad();
  return { username: { minLength: Number(u.minLength), maxLength: Number(u.maxLength), allowNumbers: u.allowNumbers, allowSeparators: u.allowSeparators }, password: { minLength: Number(p.minLength), requireUppercase: p.requireUppercase as boolean, requireLowercase: p.requireLowercase as boolean, requireNumber: p.requireNumber as boolean, requireSymbol: p.requireSymbol as boolean, disallowUsername: p.disallowUsername as boolean }, spectatorPin: { blockSimpleCodes: pin.blockSimpleCodes as boolean } };
}
export function usernameProblem(value: string, rules: SignInRules = DEFAULT_SIGN_IN_RULES): string | null {
  const username = value.trim();
  if (username.length < rules.username.minLength || username.length > rules.username.maxLength) return `Use a username of ${rules.username.minLength}–${rules.username.maxLength} characters.`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) return "Use letters, numbers, dots, underscores or dashes, starting with a letter or number.";
  if (!rules.username.allowNumbers && /\d/.test(username)) return "Use a username without numbers.";
  if (!rules.username.allowSeparators && /[._-]/.test(username)) return "Use a username without dots, underscores or dashes.";
  return null;
}
export function passwordProblem(value: string, username: string, rules: SignInRules = DEFAULT_SIGN_IN_RULES): string | null {
  const p = rules.password;
  if (value.length < p.minLength || value.length > 128) return `Use a password of ${p.minLength}–128 characters.`;
  if (p.requireUppercase && !/[A-Z]/.test(value)) return "Include an uppercase letter.";
  if (p.requireLowercase && !/[a-z]/.test(value)) return "Include a lowercase letter.";
  if (p.requireNumber && !/\d/.test(value)) return "Include a number.";
  if (p.requireSymbol && !/[^A-Za-z0-9\s]/.test(value)) return "Include a symbol.";
  if (p.disallowUsername && username.trim() && value.toLowerCase().includes(username.trim().toLowerCase())) return "Choose a password that does not contain your username.";
  return null;
}
export function pinProblem(value: string, rules: SignInRules = DEFAULT_SIGN_IN_RULES): string | null {
  if (!/^\d{4}$/.test(value)) return "Use exactly four digits.";
  return rules.spectatorPin.blockSimpleCodes ? spectatorPinProblem(value) : null;
}
const letters = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]/g, "");
/** Suggestions are checked case-insensitively; the server must reserve the final name atomically. */
export function suggestInitialUsername(teamName: string, fullName: string, existingUsernames: readonly string[] = [], rules: SignInRules = DEFAULT_SIGN_IN_RULES): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const component = (value: string) => { const text=letters(value);return rules.username.allowNumbers ? text : text.replace(/\d/g, ""); };
  const team = component(teamName.replace(/\s+U(?:[5-9]|1\d|2[01])\b.*$/i, "")) || "Team";
  const first = component(parts[0] ?? "Player") || "Player";
  const initial = parts.length > 1 ? component(parts.at(-1)!).slice(0,1).toUpperCase() : "";
  let base = `${team}${rules.username.allowSeparators ? "." : ""}${first}${initial}`;
  if (!rules.username.allowNumbers) base = base.replace(/\d/g, "");
  base = base.padEnd(rules.username.minLength, "x").slice(0, rules.username.maxLength);
  const used = new Set(existingUsernames.map(v => v.trim().toLowerCase()));
  for (let n = 1; n <= 10000; n++) {
    let suffix = n === 1 ? "" : String(n);
    if (!rules.username.allowNumbers && suffix) {
      suffix = ""; let index = n - 1;
      do { suffix = String.fromCharCode(97 + index % 26) + suffix; index = Math.floor(index / 26) - 1; } while (index >= 0);
    }
    const candidate = `${base.slice(0, rules.username.maxLength - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase()) && !usernameProblem(candidate, rules)) return candidate;
  }
  throw new Error("Choose another username; this name has too many duplicates.");
}
