import { WIRE_CONTRACT_VERSION } from '@longball/application/sync';
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { base64Url } from "@longball/application/security";
import {
  assertTeamDocumentView,
  type TeamDocumentView,
  type TeamDocumentDownload,
} from "@longball/application/team-documents";
import { Button, Card, Notice, typography } from "../ui";
import { deliverTeamFile, pickTeamFile } from "../platform/team-files";
import { randomUUID } from "../platform/id";

const encode = (bytes: Uint8Array) => {
  const value = base64Url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return value + "=".repeat((4 - (value.length % 4)) % 4);
};
function decode(value: string): Uint8Array {
  if (value.length > 6_990_508 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error("The saved PDF content is invalid.");
  const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    out: number[] = [];
  let bits = 0,
    count = 0;
  for (const c of value.replace(/=+$/, "")) {
    bits = (bits << 6) | alphabet.indexOf(c);
    count += 6;
    if (count >= 8) {
      count -= 8;
      out.push((bits >> count) & 255);
    }
  }
  return Uint8Array.from(out);
}
/** Mount keyed by account/team/season/role; every file action rechecks current server access. */
export function TeamDocumentsPanel({
  baseUrl,
  teamId,
  seasonId,
  headers,
  request = globalThis.fetch,
  disabled = false,
}: {
  baseUrl: string;
  teamId: string;
  seasonId: string;
  headers: HeadersInit;
  request?: typeof fetch;
  disabled?: boolean;
}) {
  const [view, setView] = useState<TeamDocumentView | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null),
    [confirmRemove, setConfirmRemove] = useState(false);
  const generation = useRef(0),
    active = useRef(true),
    abort = useRef<AbortController | null>(null);
  const headerKey = JSON.stringify(
    [...new Headers(headers).entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/teams/${encodeURIComponent(teamId)}/team-sheet?seasonId=${encodeURIComponent(seasonId)}`;
  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const h = new Headers(JSON.parse(headerKey) as [string, string][]);
      for (const [key, value] of new Headers(init.headers)) h.set(key, value);
      const response = await request(path, {
        ...init,
        headers: h,
        signal: abort.current?.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 403 || response.status === 404
            ? "The team sheet is unavailable for this account."
            : response.status === 409
              ? "The team sheet changed. Refresh before trying again."
              : "The team sheet request could not be completed.",
        );
      return response.json();
    },
    [headerKey, request],
  );
  useEffect(() => {
    active.current = true;
    const current = ++generation.current;
    const controller = new AbortController();
    abort.current = controller;
    void call(endpoint)
      .then((value) => {
        assertTeamDocumentView(value, teamId);
        if (active.current && current === generation.current) setView(value);
      })
      .catch((error) => {
        if (
          active.current &&
          current === generation.current &&
          !controller.signal.aborted
        )
          setMessage(
            error instanceof Error
              ? error.message
              : "The team sheet is unavailable.",
          );
      });
    return () => {
      active.current = false;
      generation.current = current + 1;
      controller.abort();
    };
  }, [endpoint, teamId, call]);
  const run = (work: () => Promise<void>) => {
    if (busy || disabled) return;
    const current = generation.current;
    setBusy(true);
    setMessage(null);
    void work()
      .catch((error) => {
        if (active.current && generation.current === current)
          setMessage(
            error instanceof Error
              ? error.message
              : "The team sheet request failed.",
          );
      })
      .finally(() => {
        if (active.current && generation.current === current) setBusy(false);
      });
  };
  const save = async (command: Record<string, unknown>) => {
    const id = randomUUID();
    const value = await call(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Contract-Version": WIRE_CONTRACT_VERSION,
        "Idempotency-Key": id,
      },
      body: JSON.stringify({
        command: { id, expectedRevision: view?.revision ?? 0, ...command },
      }),
    });
    assertTeamDocumentView(value, teamId);
    if (!active.current) return;
    setView(value);
    setConfirmRemove(false);
    setMessage("Team sheet saved.");
  };
  return (
    <Card testID="team-documents">
      <Text style={typography.section}>FA team sheet</Text>
      <Text style={typography.muted}>
        Keep a PDF ready to show the opposition manager on game day. Staff only,
        up to 5 MB and 50 pages.
      </Text>
      {message && <Notice>{message}</Notice>}
      {view?.document && (
        <Text style={typography.body}>
          {view.document.fileName} ·{" "}
          {Math.ceil(view.document.byteLength / 1024)} KB
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button
          label="Refresh"
          testID="team-sheet-refresh"
          compact
          variant="quiet"
          disabled={disabled || busy}
          onPress={() =>
            run(async () => {
              const value = await call(endpoint);
              assertTeamDocumentView(value, teamId);
              if (active.current) {
                setView(value);
                setConfirmRemove(false);
              }
            })
          }
        />
        <Button
          label={view?.document ? "Replace PDF" : "Store PDF"}
          testID="team-sheet-upload"
          compact
          variant="secondary"
          disabled={disabled || busy || !view}
          onPress={() =>
            run(async () => {
              const file = await pickTeamFile("pdf");
              if (file && active.current)
                await save({
                  type: "team_sheet.uploaded",
                  fileName: file.name,
                  base64: encode(file.bytes),
                });
            })
          }
        />
        {view?.document && (
          <>
            <Button
              label="Open / download PDF"
              testID="team-sheet-open"
              compact
              disabled={disabled || busy}
              onPress={() =>
                run(async () => {
                  const data = (await call(
                    endpoint.replace("/team-sheet?", "/team-sheet/download?"),
                  )) as TeamDocumentDownload;
                  assertTeamDocumentView(data, teamId);
                  if (!active.current || !data.document) return;
                  const bytes = decode(data.base64);
                  if (
                    bytes.length !== data.document.byteLength ||
                    String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-"
                  )
                    throw new Error("The saved PDF content is invalid.");
                  await deliverTeamFile({
                    name: data.document.fileName,
                    bytes,
                    mimeType: "application/pdf",
                  });
                })
              }
            />
            <Button
              label="Remove"
              compact
              variant="quiet"
              disabled={disabled || busy}
              onPress={() => setConfirmRemove(true)}
            />
          </>
        )}
      </View>
      {confirmRemove && (
        <View style={{ gap: 8 }}>
          <Notice>Remove the stored team sheet?</Notice>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              label="Confirm removal"
              compact
              disabled={disabled || busy}
              onPress={() => run(() => save({ type: "team_sheet.removed" }))}
            />
            <Button
              label="Keep PDF"
              compact
              variant="quiet"
              disabled={busy}
              onPress={() => setConfirmRemove(false)}
            />
          </View>
        </View>
      )}
    </Card>
  );
}
