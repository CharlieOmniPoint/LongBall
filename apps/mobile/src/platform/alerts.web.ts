export interface LocalWarningPlan { revision: string; dueInMs: number; running: boolean }

export async function getAlertCapability(): Promise<string> {
  return 'Browser review: visual clock only. Native local reminders, sound and lock behaviour require phone testing.';
}
export async function requestAlertPermission(): Promise<string> { return getAlertCapability(); }
export async function replaceLocalWarnings(_plan: LocalWarningPlan): Promise<void> {}
