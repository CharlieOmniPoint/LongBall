import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import {
  createDeviceAuthenticationAdapter,
  type DeviceEnrolledLevel,
} from "./device-auth-core";
const adapter = createDeviceAuthenticationAdapter({
  platform:
    Platform.OS === "ios"
      ? "ios"
      : Platform.OS === "android"
        ? "android"
        : "unsupported",
  async getEnrolledLevel(): Promise<DeviceEnrolledLevel> {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG)
      return "biometric_strong";
    if (level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK)
      return "biometric_weak";
    if (level === LocalAuthentication.SecurityLevel.SECRET)
      return "device_credential";
    return "none";
  },
  hasHardware: LocalAuthentication.hasHardwareAsync,
  isBiometricEnrolled: LocalAuthentication.isEnrolledAsync,
  authenticate: (options) => LocalAuthentication.authenticateAsync(options),
});
export const getDeviceAuthenticationAvailability = adapter.availability;
export const authenticateEnrolledDevice = adapter.authenticate;
export type { DeviceAuthenticationAvailability } from "./device-auth-core";
