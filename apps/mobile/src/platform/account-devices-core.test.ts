import { describe, expect, it, vi } from "vitest";
import { createAccountDevicesClient } from "./account-devices-core";
import { parseAccountDevicesDto } from "@longball/application/account-devices";
const dto = () => ({
  kind: "recognised-devices",
  accountId: "own-account",
  asOf: "2026-10-21T11:00:00.000Z",
  remoteRevocationAvailable: false,
  devices: [
    {
      deviceId: "app-id",
      source: "native_app_enrolment",
      label: null,
      platform: "ios",
      platformVerified: false,
      registeredAt: "2026-10-20T11:00:00.000Z",
      lastSeenAt: "2026-10-21T11:00:00.000Z",
    },
  ],
});
describe("own app-device inventory boundary", () => {
  it("retains truthful unknown legacy metadata without claiming platform verification", () => {
    const value = {
      ...dto(),
      devices: [
        {
          ...dto().devices[0],
          source: "match_controller_enrolment",
          platform: null,
          registeredAt: null,
          lastSeenAt: null,
        },
      ],
    };
    expect(parseAccountDevicesDto(value).devices[0].registeredAt).toBeNull();
    expect(() =>
      parseAccountDevicesDto({ ...dto(), remoteRevocationAvailable: true }),
    ).toThrow();
  });
  it("refuses foreign-account inventory and private response extras", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...dto(), accountId: "other-account" })),
      );
    const client = createAccountDevicesClient({
      accountId: "own-account",
      request,
      assertCurrent: async () => {},
    });
    await expect(client.load()).rejects.toThrow("another account");
    expect(() =>
      parseAccountDevicesDto({ ...dto(), providerSessions: [] }),
    ).toThrow();
  });
  it("sends only metadata on native registration and rechecks authority after receipt", async () => {
    const request = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(dto()))),
      assertCurrent = vi.fn().mockResolvedValue(undefined);
    const client = createAccountDevicesClient({
      accountId: "own-account",
      request,
      assertCurrent,
    });
    await client.register("app-id", "ios");
    expect(JSON.parse(request.mock.calls[0][0].body)).toEqual({
      deviceId: "app-id",
      platform: "ios",
    });
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });
  it("discards a late private inventory when authority closes", async () => {
    const assertCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("Account session changed"));
    const client = createAccountDevicesClient({
      accountId: "own-account",
      request: async () => new Response(JSON.stringify(dto())),
      assertCurrent,
    });
    await expect(client.load()).rejects.toThrow("session changed");
  });
});
