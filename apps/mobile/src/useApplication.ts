import {
  createApplicationState,
  validateApplicationState,
} from "@longball/application/application";
import type { Journal } from "./platform/types";
import { useDocument } from "./useDocument";

export function useApplication(
  journal: Journal | null,
  deviceId: string | null,
) {
  return useDocument(
    journal,
    deviceId,
    "synthetic-longball-application-v1",
    createApplicationState,
    validateApplicationState,
  );
}
