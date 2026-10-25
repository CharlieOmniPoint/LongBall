export interface AccountChoiceLabel {
  accountId: string;
  label: string;
}

/** Human names remain primary; only ambiguous names need an identity suffix. */
export function accountChoiceLabel(
  account: AccountChoiceLabel,
  choices: readonly AccountChoiceLabel[],
): string {
  const normalized = account.label.trim().toLocaleLowerCase("en-GB");
  const matching = [
    ...new Map(
      [account, ...choices]
        .filter(
          (choice) =>
            choice.label.trim().toLocaleLowerCase("en-GB") === normalized,
        )
        .map((choice) => [choice.accountId, choice]),
    ).values(),
  ];
  if (matching.length < 2) return account.label;
  const maximum = Math.max(
    ...matching.map((choice) => choice.accountId.length),
  );
  let length = Math.min(6, maximum);
  while (
    length < maximum &&
    new Set(matching.map((choice) => choice.accountId.slice(-length))).size <
      matching.length
  )
    length++;
  const suffix = account.accountId.slice(-length);
  return `${account.label} · ${length < account.accountId.length ? "…" : ""}${suffix}`;
}
