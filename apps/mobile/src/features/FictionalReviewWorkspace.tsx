import { useEffect, useState, type ComponentProps } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { openJournal } from "../platform/journal";
import type { Journal } from "../platform/types";
import { Button, colors, Notice, typography } from "../ui";
import { ConnectedWorkspace } from "./ConnectedWorkspace";

/** A journal is opened only after an explicit fictional manager entry. Real web accounts never use it. */
export function FictionalReviewWorkspace(
  props: ComponentProps<typeof ConnectedWorkspace>,
) {
  const fictionalManager =
    process.env.EXPO_PUBLIC_ENVIRONMENT !== "production" &&
    props.initialConnection?.mode === "synthetic" &&
    props.initialRole === "manager";
  const [storage, setStorage] = useState<{
    journal: Journal;
    deviceId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!fictionalManager) return;
    let active = true;
    let opened: Journal | null = null;
    void (async () => {
      try {
        opened = await openJournal();
        const diagnostics = await opened.getDiagnostics();
        if (active) {
          setStorage({ journal: opened, deviceId: diagnostics.deviceId });
          setError(null);
        } else await opened.close();
      } catch {
        if (active)
          setError(
            "The demo match journal could not be opened. Existing saved records were retained.",
          );
        if (opened) await opened.close().catch(() => undefined);
      }
    })();
    return () => {
      active = false;
      if (opened) void opened.close().catch(() => undefined);
    };
  }, [fictionalManager, attempt]);
  if (fictionalManager && !storage)
    return (
      <View style={{ gap: 12 }}>
        {error ? (
          <>
            <Notice tone="error">{error}</Notice>
            <Button
              label="Retry opening demo match records"
              onPress={() => setAttempt((value) => value + 1)}
            />
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.brand} />
            <Text style={typography.muted}>
              Opening demo match records…
            </Text>
          </>
        )}
        {props.onLeaveWorkspace && (
          <Button
            label="Choose another review account"
            variant="quiet"
            onPress={props.onLeaveWorkspace}
          />
        )}
      </View>
    );
  return (
    <ConnectedWorkspace
      {...props}
      journal={fictionalManager ? storage?.journal : undefined}
      deviceId={fictionalManager ? storage?.deviceId : undefined}
    />
  );
}
