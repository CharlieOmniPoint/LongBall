import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Text, View } from "react-native";
import type { HttpFetch } from "@longball/application/sync";
import { WIRE_CONTRACT_VERSION } from "@longball/application/sync";
import type { InviteRequest } from "@longball/application/spectator-pin";
import { randomUUID } from "../platform/id";
import { formatUkDateTime } from "@longball/application/uk-display";
import { Button, Card, Notice, typography } from "../ui";

export function InvitationRequestsPanel({
  baseUrl,
  authenticatedFetch,
  teamId,
  seasonId,
  active,
  assertCurrent,
}: {
  baseUrl: string;
  authenticatedFetch: HttpFetch;
  teamId: string;
  seasonId: string;
  active: boolean;
  assertCurrent: () => void;
}) {
  const [items, setItems] = useState<InviteRequest[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const current = useRef({
    mounted: true,
    active,
    teamId,
    seasonId,
    assertCurrent,
    authenticatedFetch,
  });
  useLayoutEffect(() => {
    current.current = {
      ...current.current,
      active,
      teamId,
      seasonId,
      assertCurrent,
      authenticatedFetch,
    };
  });
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  const scope = `${teamId}:${seasonId}`;
  const isCurrent = useCallback((captured: string) => {
    if (
      !current.current.mounted ||
      !current.current.active ||
      captured !== `${current.current.teamId}:${current.current.seasonId}`
    )
      return false;
    try {
      current.current.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }, []);
  const path = `${baseUrl.replace(/\/$/, "")}/v1/teams/${encodeURIComponent(teamId)}/invite-requests`;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!isCurrent(scope)) return;
      const response = await current.current.authenticatedFetch(
        `${path}?seasonId=${encodeURIComponent(seasonId)}`,
        { method: "GET", headers: { Accept: "application/json" }, signal },
      );
      if (!response.ok)
        throw new Error("Invitation requests could not be loaded.");
      const value = await response.json();
      if (
        !Array.isArray(value) ||
        value.length > 200 ||
        value.some(
          (item) =>
            !item ||
            typeof item.requestId !== "string" ||
            typeof item.name !== "string" ||
            typeof item.email !== "string" ||
            item.teamId !== teamId ||
            item.seasonId !== seasonId,
        )
      )
        throw new Error("The invitation request list could not be verified.");
      if (!signal?.aborted && isCurrent(scope)) setItems(value);
    },
    [path, seasonId, scope, teamId, isCurrent],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => {
      if (isCurrent(scope) && !controller.signal.aborted)
        setError("Invitation requests could not be loaded.");
    });
    return () => controller.abort();
  }, [active, refresh, isCurrent, scope]);
  const decide = async (
    request: InviteRequest,
    status: "handled" | "declined",
  ) => {
    if (busy || !isCurrent(scope)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await current.current.authenticatedFetch(
        `${path}/${encodeURIComponent(request.requestId)}/decision?seasonId=${encodeURIComponent(seasonId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Contract-Version": WIRE_CONTRACT_VERSION,
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({ status }),
        },
      );
      if (!response.ok) throw new Error("The decision could not be confirmed.");
      await refresh();
    } catch (cause) {
      if (isCurrent(scope))
        setError(
          cause instanceof Error
            ? cause.message
            : "The decision could not be confirmed.",
        );
    } finally {
      if (isCurrent(scope)) setBusy(false);
    }
  };
  if (!active) return null;
  return (
    <Card testID="staff-invitation-requests">
      <Text style={typography.section}>Invitation requests</Text>
      <Text style={typography.body}>
        Requests need a staff review. For a Spectator, create a team invitation
        below and send it to their contact email. For a Player, first link or
        add the right player profile and use player activation.
      </Text>
      {error && <Notice tone="warning">{error}</Notice>}
      {!items.length && !error && (
        <Text style={typography.muted}>
          No invitation requests for this team.
        </Text>
      )}
      {items.map((item) => (
        <View
          key={item.requestId}
          style={{
            gap: 6,
            paddingVertical: 8,
            borderTopWidth: 1,
            borderTopColor: "#e2e8f0",
          }}
        >
          <Text style={typography.body}>
            {item.name} ·{" "}
            {item.requestedRole === "player" ? "Player" : "Spectator"} ·{" "}
            {item.status}
          </Text>
          <Text selectable style={typography.muted}>
            {item.email} · {formatUkDateTime(item.createdAt)}
          </Text>
          {item.status === "pending" && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button
                compact
                variant="secondary"
                label={`Mark ${item.name} handled`}
                disabled={busy}
                onPress={() => {
                  void decide(item, "handled");
                }}
              />
              <Button
                compact
                variant="quiet"
                label={`Decline ${item.name}`}
                disabled={busy}
                onPress={() => {
                  void decide(item, "declined");
                }}
              />
            </View>
          )}
        </View>
      ))}
      <Button
        compact
        variant="quiet"
        label="Refresh invitation requests"
        disabled={busy}
        onPress={() => {
          void refresh().catch(() =>
            setError("Invitation requests could not be loaded."),
          );
        }}
      />
    </Card>
  );
}
