import { describe, expect, it } from "vitest";
import { accountChoiceLabel } from "./account-choice-labels";

describe("safe adult account choices", () => {
  it("keeps a unique human name plain and does not treat duplicate rows as different people", () => {
    const account = { accountId: "account-one", label: "Alex Morgan" };
    expect(accountChoiceLabel(account, [account, account])).toBe("Alex Morgan");
    expect(
      accountChoiceLabel(account, [
        { accountId: "account-two", label: "Jordan Reed" },
      ]),
    ).toBe("Alex Morgan");
  });
  it("extends identity suffixes until every same-name account can be distinguished", () => {
    const choices = [
      { accountId: "north-account-abcdef", label: "Alex Morgan" },
      { accountId: "south-account-abcdef", label: "alex morgan" },
      { accountId: "short", label: "Alex Morgan" },
    ];
    const labels = choices.map((account) =>
      accountChoiceLabel(account, choices),
    );
    expect(new Set(labels.map((label) => label.toLowerCase())).size).toBe(3);
    expect(labels[0]).toContain("Alex Morgan · ");
    expect(labels[0]).not.toBe("Alex Morgan · …abcdef");
    expect(labels[2]).toBe("Alex Morgan · short");
  });
});
