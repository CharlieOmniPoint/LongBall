import { forwardRef, useEffect, useImperativeHandle } from "react";
import { Text, View } from "react-native";
import {
  createWorkspaceOutbox,
  enqueueWorkspaceRequest,
  recordWorkspaceOutcome,
  validateWorkspaceOutbox,
  workspaceOutboxDocumentId,
  type WorkspaceOutboxState,
  type WorkspaceRequestInput,
  type WorkspaceRequestOutcome,
} from "@longball/application/workspace-outbox";
import type { WorkspaceBinding } from "@longball/application/workspace-boundary";
import type { Journal } from "../platform/types";
import { useDocument } from "../useDocument";
import { Button, Notice } from "../ui";
import { typography } from "../ui/tokens";

export interface WorkspaceOutboxStatus {
  state: WorkspaceOutboxState | null;
  busy: boolean;
  error: string | null;
  retryPending: boolean;
  conflict: boolean;
}
export interface WorkspaceOutboxPort {
  snapshot: () => WorkspaceOutboxState | null;
  enqueue: (
    binding: WorkspaceBinding,
    request: WorkspaceRequestInput,
  ) => Promise<WorkspaceOutboxState | null>;
  settle: (key: string, outcome: WorkspaceRequestOutcome) => Promise<boolean>;
}
export const WorkspaceOutboxBridge = forwardRef<
  WorkspaceOutboxPort,
  {
    binding: WorkspaceBinding;
    journal: Journal;
    deviceId: string;
    onStatus: (status: WorkspaceOutboxStatus) => void;
  }
>(function WorkspaceOutboxBridge(
  { binding, journal, deviceId, onStatus },
  ref,
) {
  const document = useDocument(
    journal,
    deviceId,
    workspaceOutboxDocumentId(binding),
    () => createWorkspaceOutbox(binding),
    validateWorkspaceOutbox,
  );
  useImperativeHandle(
    ref,
    () => ({
      snapshot: () => document.state,
      enqueue: async (currentBinding, input) => {
        let retained: WorkspaceOutboxState | null = null;
        const saved = await document.change((current) => {
          retained = enqueueWorkspaceRequest(
            current,
            currentBinding,
            input,
            Date.now(),
          );
          return retained;
        }, "workspace.request.retained");
        return saved ? retained : null;
      },
      settle: (key, outcome) =>
        document.change(
          (current) =>
            recordWorkspaceOutcome(current, key, outcome, Date.now()),
          "workspace.receipt.retained",
        ),
    }),
    [document],
  );
  useEffect(() => {
    onStatus({
      state: document.state,
      busy: document.busy,
      error: document.error,
      retryPending: document.retryPending,
      conflict: document.conflict,
    });
  }, [
    onStatus,
    document.state,
    document.busy,
    document.error,
    document.retryPending,
    document.conflict,
  ]);
  return (
    <View style={{ gap: 8 }}>
      <Text style={typography.muted}>
        {document.state
          ? "Exact service requests are retained in this workspace’s protected journal before sending. They are replayed only after a fresh identity and access check."
          : "Opening protected request storage…"}
      </Text>
      {document.error && <Notice tone="error">{document.error}</Notice>}
      {document.retryPending && (
        <Button
          label="Retry protected request save"
          variant="secondary"
          disabled={document.busy}
          onPress={() => {
            void document.retry();
          }}
        />
      )}
      {document.conflict && (
        <>
          <Notice tone="warning">
            Another local context changed this outbox. The rejected candidate
            remains retained; reload the saved outbox before retrying the
            service.
          </Notice>
          <Button
            label="Reload saved protected outbox"
            variant="secondary"
            disabled={document.busy}
            onPress={document.reload}
          />
        </>
      )}
    </View>
  );
});
