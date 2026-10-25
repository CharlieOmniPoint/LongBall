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
  onChanged,
}: {
  baseUrl: string;
  authenticatedFetch: HttpFetch;
  teamId: string;
  seasonId: string;
  active: boolean;
  assertCurrent: () => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [value, setValue] = useState<Connections | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [loadAttempt, setLoadAttempt] = useState(0),
    [error, setError] = useState<string | null>(null);
  const path = `${baseUrl.replace(/\/$/, "")}/v1/teams/${encodeURIComponent(teamId)}/spectator-connections?seasonId=${encodeURIComponent(seasonId)}`;
  const generation = useRef(0),
    operation = useRef<AbortController | null>(null),
    refreshedAttempt = useRef(0),
    valuePath = useRef(path);
  const live = useRef({
    mounted: true,
    path,
    active,
    authenticatedFetch,
    assertCurrent,
    onChanged,
  });
  useLayoutEffect(() => {
    live.current = {
      ...live.current,
      path,
      active,
      authenticatedFetch,
      assertCurrent,
      onChanged,
    };
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
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    operation.current = controller;
    void Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted || !current(captured, path)) return;
        setBusy(false);
        setError(null);
        if (valuePath.current !== path) {
          valuePath.current = path;
          setValue(null);
        }
        setLoading(true);
        const response = await live.current.authenticatedFetch(path, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          if (
            [401, 403, 404].includes(response.status) &&
            current(captured, path)
          )
            setValue(null);
          throw new Error("Could not load player connections.");
        }
        const next = verified(await response.json());
        if (!controller.signal.aborted && current(captured, path)) {
          setValue(next);
          if (loadAttempt > refreshedAttempt.current) {
            refreshedAttempt.current = loadAttempt;
            try {
              await live.current.onChanged?.();
            } catch {
              if (current(captured, path))
                setError(
                  "Your choice is confirmed, but other team views could not refresh. Retry connections before continuing.",
                );
            }
          }
        }
      })
      .catch(() => {
        if ((!controller.signal.aborted || timedOut) && current(captured, path))
          setError(
            timedOut
              ? "Loading your connections took too long. Retry when connected."
              : "We could not load your player connections. Retry to check your choice.",
          );
      })
      .finally(() => {
        clearTimeout(deadline);
        if (operation.current === controller) operation.current = null;
        if (current(captured, path)) setLoading(false);
      });
    return () => {
      clearTimeout(deadline);
      controller.abort();
      generation.current += 1;
    };
    // Callback references are deliberately read from live: the workspace refreshes its clock each second.
  }, [path, active, current, loadAttempt]);
  const save = async (playerId: string | null) => {
    const captured = generation.current;
    if (busy || operation.current || !value || !current(captured, path)) return;
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
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
      if (!response.ok) {
        if (
          [401, 403, 404].includes(response.status) &&
          current(captured, path)
        )
          setValue(null);
        throw new Error("Your player connection could not be saved.");
      }
      const next = verified(await response.json());
      if (!controller.signal.aborted && current(captured, path)) {
        setValue(next);
        try {
          await live.current.onChanged?.();
        } catch {
          if (current(captured, path))
            setError(
              "Your choice is confirmed, but other team views could not refresh. Retry connections before continuing.",
            );
        }
      }
    } catch {
      if ((!controller.signal.aborted || timedOut) && current(captured, path))
        setError(
          "We could not confirm your choice. Refresh connections to check it before trying again.",
        );
    } finally {
      clearTimeout(deadline);
      if (operation.current === controller) operation.current = null;
      if (current(captured, path)) setBusy(false);
    }
  };
  if (!active) return null;
  const controlsBusy = busy || loading;
  const supportedPlayer = value?.players.find(
    (player) => player.id === value.followedPlayerId,
  );
  return (
    <Card testID="spectator-player-connection">
      <Text style={typography.section}>Who are you here to support?</Text>
      <Text style={typography.muted}>
        Follow the whole team or choose a player. Private player records stay
        private.
      </Text>
      {loading && (
        <Text style={typography.muted} testID="spectator-connections-loading">
          Loading your player connections…
        </Text>
      )}
      {error && <Notice tone="warning">{error}</Notice>}
      {value && (
        <>
          <Text
            style={typography.label}
            accessibilityLiveRegion="polite"
            testID="spectator-connection-current"
          >
            {busy
              ? "Saving your choice…"
              : loading
                ? "Checking your saved choice…"
                : `${error ? "Last confirmed: " : ""}${supportedPlayer ? `Supporting ${supportedPlayer.label}` : "Following the whole team"}`}
          </Text>
          {!value.players.length && (
            <Text style={typography.muted}>
              No player names are available yet. You can still follow the whole
              team.
            </Text>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              compact
              label="Whole team"
              variant={
                value.followedPlayerId === null ? "primary" : "secondary"
              }
              accessibilityState={{ selected: value.followedPlayerId === null }}
              testID="spectator-support-team"
              disabled={controlsBusy}
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
                accessibilityState={{
                  selected: value.followedPlayerId === player.id,
                }}
                testID={`spectator-support-player-${player.id}`}
                disabled={controlsBusy}
                onPress={() => {
                  void save(player.id);
                }}
              />
            ))}
          </View>
        </>
      )}
      <View style={{ alignSelf: "flex-start" }}>
        <Button
          label={error ? "Retry connections" : "Refresh connections"}
          testID="spectator-connections-refresh"
          compact
          variant={error ? "secondary" : "quiet"}
          disabled={controlsBusy}
          onPress={() => setLoadAttempt((attempt) => attempt + 1)}
        />
      </View>
    </Card>
  );
}
