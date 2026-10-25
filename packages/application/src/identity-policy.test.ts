import { describe, expect, it } from "vitest";
import { DEFAULT_SIGN_IN_RULES, parseSignInRules, passwordProblem, pinProblem, suggestInitialUsername, usernameProblem } from "./identity-policy";

describe("application-wide sign-in rules", () => {
  it("validates exact bounded rule fields without accepting arbitrary regular expressions", () => {
    expect(parseSignInRules(DEFAULT_SIGN_IN_RULES)).toEqual(DEFAULT_SIGN_IN_RULES);
    for (const value of [null, { ...DEFAULT_SIGN_IN_RULES, expression: ".*" }, { ...DEFAULT_SIGN_IN_RULES, username: { ...DEFAULT_SIGN_IN_RULES.username, minLength: 2 } }, { ...DEFAULT_SIGN_IN_RULES, username: { ...DEFAULT_SIGN_IN_RULES.username, maxLength: 41 } }, { ...DEFAULT_SIGN_IN_RULES, password: { ...DEFAULT_SIGN_IN_RULES.password, minLength: 7 } }, { ...DEFAULT_SIGN_IN_RULES, password: { ...DEFAULT_SIGN_IN_RULES.password, minLength: 65 } }]) expect(() => parseSignInRules(value)).toThrow();
  });
  it("suggests readable team and player names with case-insensitive collision suffixes", () => {
    expect(suggestInitialUsername("Roma U10", "Seb Lawler")).toBe("Roma.SebL");
    expect(suggestInitialUsername("Roma", "Seb Lawler", ["roma.sebl", "ROMA.SEBL2"])).toBe("Roma.SebL3");
    expect(suggestInitialUsername("Róma", "SéB Låwler")).toBe("Roma.SeBL");
    const rules = parseSignInRules({ ...DEFAULT_SIGN_IN_RULES, username: { minLength: 8, maxLength: 8, allowNumbers: false, allowSeparators: false } });
    const name = suggestInitialUsername("Roma U10", "Seb Lawler", ["romasebl"], rules);
    expect(name).toHaveLength(8); expect(usernameProblem(name, rules)).toBeNull(); expect(name).not.toMatch(/[\d._-]/);
    const numericTeamRules = { ...DEFAULT_SIGN_IN_RULES, username: { ...DEFAULT_SIGN_IN_RULES.username, allowNumbers:false } };
    expect(suggestInitialUsername("1860", "Seb Lawler", [], numericTeamRules)).toBe("Team.SebL");
  });
  it("enforces password and spectator PIN creation rules without altering login validation", () => {
    expect(passwordProblem("longenough!27A", "Roma.SebL")).toBeNull();
    expect(passwordProblem("Roma.SebL!27long", "roma.sebl")).toMatch(/username/);
    expect(passwordProblem("longenough27A ", "Roma.SebL")).toMatch(/symbol/);
    expect(pinProblem("1111")).toBeTruthy(); expect(pinProblem("4729")).toBeNull();
    const rules = { ...DEFAULT_SIGN_IN_RULES, spectatorPin: { blockSimpleCodes: false } };
    expect(pinProblem("1111", rules)).toBeNull(); expect(pinProblem("12345", rules)).toBeTruthy();
    expect(usernameProblem("Roma.SebL")).toBeNull(); expect(usernameProblem("Roma/SebL")).toBeTruthy();
  });
});
