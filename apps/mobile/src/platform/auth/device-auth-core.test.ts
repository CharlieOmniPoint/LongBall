import { describe, expect, it, vi } from "vitest";
import {
  createDeviceAuthenticationAdapter,
  type NativeDeviceAuthenticationPort,
} from "./device-auth-core";
function fixture(patch: Partial<NativeDeviceAuthenticationPort> = {}) {
  const port: NativeDeviceAuthenticationPort = {
    platform: "android",
    getEnrolledLevel: vi.fn(async () => "biometric_strong" as const),
    hasHardware: vi.fn(async () => true),
    isBiometricEnrolled: vi.fn(async () => true),
    authenticate: vi.fn(async () => ({ success: true })),
    ...patch,
  };
  return { port, adapter: createDeviceAuthenticationAdapter(port) };
}
describe("native OS convenience authentication adapter", () => {
  it("allows an enrolled device credential without inventing biometric enrollment", async () => {
    const { port, adapter } = fixture({
      getEnrolledLevel: vi.fn(async () => "device_credential" as const),
      hasHardware: vi.fn(async () => false),
      isBiometricEnrolled: vi.fn(async () => false),
    });
    expect(await adapter.availability()).toMatchObject({
      available: true,
      enrolledLevel: "device_credential",
      biometricEnrolled: false,
    });
    expect(await adapter.authenticate()).toEqual({ success: true });
    expect(port.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        disableDeviceFallback: false,
        biometricsSecurityLevel: "strong",
        requireConfirmation: true,
      }),
    );
  });
  it("does not prompt unsupported platforms or treat a browser as native proof", async () => {
    const { port, adapter } = fixture({ platform: "unsupported" });
    expect(await adapter.authenticate()).toEqual({
      success: false,
      reason: "unavailable",
    });
    expect(port.getEnrolledLevel).not.toHaveBeenCalled();
    expect(port.authenticate).not.toHaveBeenCalled();
  });
  it("rechecks enrollment before each prompt and refuses missing enrollment", async () => {
    const level = vi
      .fn<NativeDeviceAuthenticationPort["getEnrolledLevel"]>()
      .mockResolvedValueOnce("biometric_strong")
      .mockResolvedValue("none");
    const { port, adapter } = fixture({ getEnrolledLevel: level });
    expect((await adapter.availability()).available).toBe(true);
    expect(await adapter.authenticate()).toEqual({
      success: false,
      reason: "unavailable",
    });
    expect(port.authenticate).not.toHaveBeenCalled();
  });
  it.each(["user_cancel", "app_cancel", "system_cancel"])(
    "keeps %s cancellation distinct from successful authentication",
    async (error) => {
      const { adapter } = fixture({
        authenticate: vi.fn(async () => ({ success: false, error })),
      });
      expect(await adapter.authenticate()).toEqual({
        success: false,
        reason: "cancelled",
      });
    },
  );
  it("never converts an OS exception or malformed truthy result into success", async () => {
    const failure = fixture({
      authenticate: vi.fn(async () => {
        throw new Error("native module failed");
      }),
    });
    expect(await failure.adapter.authenticate()).toEqual({
      success: false,
      reason: "unavailable",
    });
    const malformed = fixture({
      authenticate: vi.fn(async () => ({
        success: "true" as unknown as boolean,
      })),
    });
    expect(await malformed.adapter.authenticate()).toEqual({
      success: false,
      reason: "rejected",
    });
  });
  it("refuses capability uncertainty without opening a prompt", async () => {
    const { port, adapter } = fixture({
      getEnrolledLevel: vi.fn(async () => {
        throw new Error("unknown device state");
      }),
    });
    expect(await adapter.authenticate()).toEqual({
      success: false,
      reason: "unavailable",
    });
    expect(port.authenticate).not.toHaveBeenCalled();
  });
});
