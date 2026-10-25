export interface DemoFixtureIdContext {
  environment: string | undefined;
  allowSynthetic: boolean | undefined;
  connectionMode: "synthetic" | "oidc";
  platform: string;
  /** The issuer must come from the currently verified service principal. */
  principal: Readonly<{ issuer: string }> | null;
}

/** Names a newly created demo fixture without widening the browser editor gate. */
export function demoFixtureId(
  newUuid: string,
  context: Readonly<DemoFixtureIdContext>,
): string {
  const demoBrowser =
    (context.environment === "development" ||
      context.environment === "fictional") &&
    context.allowSynthetic === true &&
    context.connectionMode === "synthetic" &&
    context.platform === "web" &&
    context.principal?.issuer === "urn:longball:synthetic";
  return demoBrowser ? `synthetic-${newUuid}` : newUuid;
}
