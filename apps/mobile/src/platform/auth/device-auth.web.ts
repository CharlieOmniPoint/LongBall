import type {
  DeviceAuthenticationAvailability,
  DeviceAuthenticationResult,
} from "./device-auth-core";
export async function getDeviceAuthenticationAvailability(): Promise<DeviceAuthenticationAvailability> {
  return {
    available: false,
    platform: "unsupported",
    enrolledLevel: "none",
    hasBiometricHardware: false,
    biometricEnrolled: false,
    reason: "unsupported",
  };
}
export async function authenticateEnrolledDevice(): Promise<DeviceAuthenticationResult> {
  return { success: false, reason: "unavailable" };
}
