import { createAccountRequestsClient } from "./account-requests-core";
import {
  connectedFetch,
  getConnectedSessionSummary,
  type ConnectedSessionSummary,
} from "./auth/client";
import { randomUUID } from "./id";
export function connectedAccountRequestsClient(
  session: ConnectedSessionSummary,
) {
  const base = session.config.apiBaseUrl.replace(/\/$/, "");
  const url = `${base}${base.endsWith("/v1") ? "" : "/v1"}/privacy/requests`;
  return createAccountRequestsClient({
    accountId: session.accountId,
    newId: randomUUID,
    request: (init) => connectedFetch(url, init),
    assertCurrent: async () => {
      const current = await getConnectedSessionSummary();
      if (
        !current ||
        current.issuer !== session.issuer ||
        current.accountId !== session.accountId ||
        current.sessionId !== session.sessionId ||
        current.config.apiBaseUrl !== session.config.apiBaseUrl ||
        current.locked ||
        current.expired ||
        current.expiresAtMs <= Date.now()
      )
        throw new Error("Account session changed");
    },
  });
}
