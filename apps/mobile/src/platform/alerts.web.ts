export interface LocalWarningPlan {
  revision: string;
  dueInMs: number;
  running: boolean;
  owner?: string;
  leadSeconds?: number;
  sound?: boolean;
}

export async function getAlertCapability(): Promise<string> {
  return "Browser review: visual countdown and foreground substitution audio. Native local notifications and lock behaviour require device testing.";
}
export async function requestAlertPermission(): Promise<string> {
  return getAlertCapability();
}
export async function replaceLocalWarnings(
  _plan: LocalWarningPlan,
): Promise<void> {}
