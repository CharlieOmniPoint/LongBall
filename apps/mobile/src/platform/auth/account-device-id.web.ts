export async function accountDeviceId(
  _issuer: string,
  _accountId: string,
): Promise<string> {
  throw new Error(
    "Browser review does not register a durable native app device.",
  );
}
