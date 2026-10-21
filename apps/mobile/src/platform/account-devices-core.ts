import {
  parseAccountDevicesDto,
  type AccountDevicesDto,
} from "@longball/application/account-devices";
export function createAccountDevicesClient(port: {
  accountId: string;
  request: (init: RequestInit) => Promise<Response>;
  assertCurrent: () => Promise<void>;
}) {
  async function call(init: RequestInit): Promise<AccountDevicesDto> {
    await port.assertCurrent();
    const response = await port.request(init);
    await port.assertCurrent();
    if (!response.ok)
      throw new Error(
        "The service could not confirm this account's known app devices.",
      );
    const text = await response.text();
    await port.assertCurrent();
    if (text.length > 256_000)
      throw new Error("Device inventory response exceeded its limit.");
    const result = parseAccountDevicesDto(JSON.parse(text));
    if (result.accountId !== port.accountId)
      throw new Error(
        "Device inventory belonged to another account and was discarded.",
      );
    return result;
  }
  return {
    load: () =>
      call({ method: "GET", headers: { accept: "application/json" } }),
    register: (deviceId: string, platform: "ios" | "android") =>
      call({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ deviceId, platform }),
      }),
  };
}
