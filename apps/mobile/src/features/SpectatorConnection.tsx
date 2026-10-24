import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { HttpFetch } from "@longball/application/sync";
import { WIRE_CONTRACT_VERSION } from "@longball/application/sync";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, typography } from "../ui";
interface Connections {
  players: { id: string; label: string }[];
  followedPlayerId: string | null;
}
function verified(value: unknown): Connections {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Player connections could not be verified.");
  const data = value as Connections;
  if (
    !Array.isArray(data.players) ||
    data.players.length > 200 ||
    data.players.some(
      (player) =>
        !player ||
        typeof player.id !== "string" ||
        typeof player.label !== "string",
    ) ||
    (data.followedPlayerId !== null &&
      !data.players.some((player) => player.id === data.followedPlayerId))
  )
    throw new Error("Player connections could not be verified.");
  return data;
}
/** Parent keys this view by account/team/season. Following never grants a player identity or private records. */
export function SpectatorConnection({
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
  const [value, setValue] = useState<Connections | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const path = `${baseUrl.replace(/\/$/, "")}/v1/teams/${encodeURIComponent(teamId)}/spectator-connections?seasonId=${encodeURIComponent(seasonId)}`;
  const generation = useRef(0),
    operation = useRef<AbortController | null>(null);
  const live = useRef({
    mounted: true,
    path,
    active,
    authenticatedFetch,
    assertCurrent,
  });
  useLayoutEffect(() => {
    live.current = { ...live.current, path, active, authenticatedFetch, assertCurrent };
  });
  const current = useCallback((captured: number, capturedPath: string) => {
    const state = live.current;
    if (
      !state.mounted ||
      !state.active ||
      generation.current !== captured ||
      state.path !== capturedPath
    )
      return false;
    try {
      state.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }, []);
  useEffect(() => {
    live.current.mounted = true;
    return () => {
      live.current.mounted = false;
      generation.current += 1;
      operation.current?.abort();
    };
  }, []);
  useEffect(() => {
    const captured = ++generation.current;
    operation.current?.abort();
    operation.current = null;
    if (!active) return;
    const controller = new AbortController();
    operation.current = controller;
    void Promise.resolve()
      .then(async () => {
        if (!current(captured, path)) return;
        const response = await live.current.authenticatedFetch(path, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Could not load player connections.");
        const next = verified(await response.json());
        if (!controller.signal.aborted && current(captured, path))
          setValue(next);
      })
      .catch(() => {
        if (!controller.signal.aborted && current(captured, path))
          setError("Player connections could not be loaded.");
      })
      .finally(() => {
        if (operation.current === controller) operation.current = null;
      });
    return () => {
      controller.abort();
      generation.current += 1;
    };
    // Callback references are deliberately read from live: the workspace refreshes its clock each second.
  }, [path, active, current]);
  const save = async (playerId: string | null) => {
    const captured = generation.current;
    if (busy || operation.current || !value || !current(captured, path)) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await live.current.authenticatedFetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Contract-Version": WIRE_CONTRACT_VERSION,
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ playerId }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error("Your player connection could not be saved.");
      const next = verified(await response.json());
      if (!controller.signal.aborted && current(captured, path)) setValue(next);
    } catch {
      if (!controller.signal.aborted && current(captured, path))
        setError(
          "Your player connection could not be saved. Refresh and try again.",
        );
    } finally {
      if (operation.current === controller) operation.current = null;
      if (current(captured, path)) setBusy(false);
    }
  };
  if (!active) return null;
  return (
    <Card testID="spectator-player-connection">
      <Text style={typography.section}>Who are you here to support?</Text>
      <Text style={typography.muted}>
        Choose a player for this team, or follow the whole team. Your choice
        stays on your account and does not give access to private player
        records.
      </Text>
      {error && <Notice tone="warning">{error}</Notice>}
      {value && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button
            compact
            label="Whole team"
            variant={value.followedPlayerId === null ? "primary" : "secondary"}
            disabled={busy}
            onPress={() => {
              void save(null);
            }}
          />
          {value.players.map((player) => (
            <Button
              compact
              key={player.id}
              label={player.label}
              variant={
                value.followedPlayerId === player.id ? "primary" : "secondary"
              }
              disabled={busy}
              onPress={() => {
                void save(player.id);
              }}
            />
          ))}
        </View>
      )}
    </Card>
  );
}
