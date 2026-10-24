export type DeviceAuthenticationPlatform = "ios" | "android" | "unsupported";
export type DeviceEnrolledLevel =
  | "none"
  | "device_credential"
  | "biometric_weak"
  | "biometric_strong";
export interface DeviceAuthenticationAvailability {
  available: boolean;
  platform: DeviceAuthenticationPlatform;
  enrolledLevel: DeviceEnrolledLevel;
  hasBiometricHardware: boolean;
  biometricEnrolled: boolean;
  reason: "unsupported" | "not_enrolled" | "unavailable" | null;
}
export type DeviceAuthenticationResult =
  | { success: true }
  | { success: false; reason: "cancelled" | "unavailable" | "rejected" };
export interface DeviceAuthenticationOptions {
  promptMessage: string;
  cancelLabel: string;
  fallbackLabel: string;
  disableDeviceFallback: false;
  biometricsSecurityLevel: "strong";
  requireConfirmation: true;
}
export interface NativeDeviceAuthenticationPort {
  platform: DeviceAuthenticationPlatform;
  getEnrolledLevel(): Promise<DeviceEnrolledLevel>;
  hasHardware(): Promise<boolean>;
  isBiometricEnrolled(): Promise<boolean>;
  authenticate(
    options: DeviceAuthenticationOptions,
  ): Promise<{ success: boolean; error?: string }>;
}
/** OS authentication is a local convenience proof. This adapter cannot issue credentials or server authority. */
export function createDeviceAuthenticationAdapter(
  port: NativeDeviceAuthenticationPort,
) {
  async function availability(): Promise<DeviceAuthenticationAvailability> {
    const empty = {
      available: false,
      platform: port.platform,
      enrolledLevel: "none" as const,
      hasBiometricHardware: false,
      biometricEnrolled: false,
    };
    if (port.platform === "unsupported")
      return { ...empty, reason: "unsupported" };
    try {
      const [enrolledLevel, hasBiometricHardware, biometricEnrolled] =
        await Promise.all([
          port.getEnrolledLevel(),
          port.hasHardware(),
          port.isBiometricEnrolled(),
        ]);
      if (
        ![
          "none",
          "device_credential",
          "biometric_weak",
          "biometric_strong",
        ].includes(enrolledLevel)
      )
        return { ...empty, reason: "unavailable" };
      return {
        available: enrolledLevel !== "none",
        platform: port.platform,
        enrolledLevel,
        hasBiometricHardware,
        biometricEnrolled,
        reason: enrolledLevel === "none" ? "not_enrolled" : null,
      };
    } catch {
      return { ...empty, reason: "unavailable" };
    }
  }
  async function authenticate(): Promise<DeviceAuthenticationResult> {
    if (!(await availability()).available)
      return { success: false, reason: "unavailable" };
    try {
      const result = await port.authenticate({
        promptMessage: "Unlock LongBall",
        cancelLabel: "Cancel",
        fallbackLabel: "Use device passcode",
        disableDeviceFallback: false,
        biometricsSecurityLevel: "strong",
        requireConfirmation: true,
      });
      if (result?.success === true) return { success: true };
      if (
        ["user_cancel", "app_cancel", "system_cancel"].includes(
          result?.error ?? "",
        )
      )
        return { success: false, reason: "cancelled" };
      if (
        ["not_available", "not_enrolled", "passcode_not_set"].includes(
          result?.error ?? "",
        )
      )
        return { success: false, reason: "unavailable" };
      return { success: false, reason: "rejected" };
    } catch {
      return { success: false, reason: "unavailable" };
    }
  }
  return { availability, authenticate };
}
