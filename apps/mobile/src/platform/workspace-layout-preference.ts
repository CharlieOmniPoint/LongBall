import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  parseWorkspaceLayoutPreference,
  type WorkspaceLayoutPreference,
} from "@longball/application/workspace-layout";

const key = "longball.layout.v1.staff";
/** Only a non-sensitive display choice is stored. No account identifiers or authority are persisted here. */
export async function readLayoutPreference(): Promise<WorkspaceLayoutPreference> {
  const value =
    Platform.OS === "web"
      ? globalThis.localStorage.getItem(key)
      : await SecureStore.getItemAsync(key);
  return parseWorkspaceLayoutPreference(value);
}
export async function saveLayoutPreference(
  value: WorkspaceLayoutPreference,
): Promise<void> {
  if (Platform.OS === "web") globalThis.localStorage.setItem(key, value);
  else await SecureStore.setItemAsync(key, value);
}
