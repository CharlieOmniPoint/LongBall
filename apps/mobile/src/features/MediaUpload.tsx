import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";
import type { CommunityActor } from "@longball/application/community";
import {
  albumScopeKey,
  assertAlbumUploadTarget,
  captureAlbumUploadTarget,
  resolveAlbumSelection,
  type AlbumScope,
  type AlbumMatch,
  type AlbumSelection,
} from "@longball/application/album-selection";
import { base64Url } from "@longball/application/security";
import { connectedFetch } from "../platform/auth/client";
import { randomUUID } from "../platform/id";
import {
  generatedFictionalImage,
  pickMediaImage,
  recoverPickedMediaImage,
} from "../platform/media-picker";
import {
  MediaUploadClient,
  type LocalUploadImage,
  type RemoteMediaReceipt,
  type RemoteOwnUpload,
  type RemotePreparedUpload,
} from "../platform/media-client";
import { Button, Card, colors, Notice, Pill } from "../ui";

export interface MediaUploadProps {
  actor: CommunityActor;
  apiBaseUrl?: string;
  synthetic?: boolean;
  albumScope: AlbumScope;
  matches: AlbumMatch[];
  selection: AlbumSelection | null;
  allowed: boolean;
  contributionsAllowed?: boolean;
  onRetainedChange?: (retained: boolean, scopeKey: string) => void;
  onChanged?: () => void | Promise<void>;
  allowLibraryPicker?: boolean;
}
interface UploadJob {
  target: AlbumSelection;
  requestId: string;
  image: LocalUploadImage;
  sha256: string;
  caption: string;
  prepared?: RemotePreparedUpload;
}
function standardBase64(bytes: Uint8Array) {
  const encoded = base64Url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
}
export function MediaUpload(props: MediaUploadProps) {
  return (
    <MediaUploadContent
      key={`${albumScopeKey(props.albumScope)}:${props.synthetic}`}
      {...props}
    />
  );
}
function MediaUploadContent(props: MediaUploadProps) {
  const {
    actor,
    apiBaseUrl = "/",
    synthetic = false,
    albumScope,
    matches,
    selection,
    allowed,
    onChanged,
    allowLibraryPicker = false,
  } = props;
  const scopeKey = albumScopeKey(albumScope);
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      live.current.onRetainedChange?.(false, scopeKey);
    };
  }, [scopeKey]);
  const target = resolveAlbumSelection(albumScope, matches, selection, allowed);
  const setRetained = (job: UploadJob | null) => {
    retained.current = job;
    setRetainedAction(Boolean(job));
    live.current.onRetainedChange?.(Boolean(job), scopeKey);
  };
  const assertCurrent = (job: UploadJob) => {
    if (!alive.current)
      throw new Error(
        "This upload screen has closed. Reopen the current authorised album.",
      );
    const current = live.current;
    if (current.contributionsAllowed === false)
      throw new Error(
        "Photo contributions are held in this team. The original private request remains retained; refresh after a manager reinstates the privilege.",
      );
    assertAlbumUploadTarget(
      current.albumScope,
      current.matches,
      job.target,
      current.allowed,
    );
  };
  const [image, setImage] = useState<LocalUploadImage | null>(null);
  const [caption, setCaption] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const retained = useRef<UploadJob | null>(null);
  const [retainedAction, setRetainedAction] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RemoteMediaReceipt | null>(null);
  const [uploads, setUploads] = useState<RemoteOwnUpload[] | null>(null);
  const [privateImage, setPrivateImage] = useState<string | null>(null);
  const client = useMemo(
    () =>
      new MediaUploadClient(apiBaseUrl, actor, async (url, options) => {
        const absolute =
          url.startsWith("/") && Platform.OS === "web"
            ? new URL(url, globalThis.location.origin).toString()
            : url;
        if (!synthetic) return connectedFetch(absolute, options);
        return fetch(absolute, {
          ...options,
          redirect: "error",
          headers: {
            ...options.headers,
            Authorization: `Bearer ${actor.accountId}`,
          },
        });
      }),
    [apiBaseUrl, actor, synthetic],
  );
  const refresh = async () => {
    const rows = await client.listOwn();
    if (alive.current) setUploads(rows);
  };
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (alive.current) {
        setPrivateImage(null);
        setError(
          failure instanceof Error
            ? failure.message
            : "The media request failed. The private record is retained.",
        );
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const execute = async (job: UploadJob) => {
    assertCurrent(job);
    setRetained(job);
    setReceipt(null);
    if (!job.prepared) {
      setPhase("Preparing a private, write-only upload…");
      const prepared = await client.prepare({
        requestId: job.requestId,
        matchId: job.target.matchId,
        image: job.image,
        sha256: job.sha256,
        caption: job.caption,
      });
      assertCurrent(job);
      job = { ...job, prepared };
      setRetained(job);
    }
    assertCurrent(job);
    setPhase("Uploading the exact bytes to private quarantine…");
    await client.upload(job.prepared!, job.image, job.requestId);
    assertCurrent(job);
    setPhase(
      "Checking size, hash, file type, scanning and metadata-free derivatives…",
    );
    const processed = await client.complete(job.prepared!, job.requestId);
    assertCurrent(job);
    setReceipt(processed);
    setRetained(null);
    setPhase(
      actor.role === "manager"
        ? "Processed privately. Explicit manager Publish is still required."
        : "Processed privately. Pending manager approval.",
    );
    await refresh();
    await onChanged?.();
  };
  if (actor.role === "spectator")
    return (
      <Card>
        <Text style={s.heading}>Private image uploads</Text>
        <Notice>
          Spectators can view authorised published images, but cannot upload,
          vote or invite.
        </Notice>
      </Card>
    );
  return (
    <Card>
      <Text style={s.heading}>Connected image upload</Text>
      <Pill tone="info">
        {synthetic ? "UPLOAD REVIEW" : "AUTHENTICATED SERVICE"}
      </Pill>
      <Notice>
        {target
          ? `Selected game: ${target.label}. The upload stays bound to this game through retries.`
          : "Select the actual permitted game in Game albums before preparing an upload."}
      </Notice>
      <Text style={s.body}>
        Prepare, upload and complete through the service. An uploaded file stays
        private until processing and the required publication action succeed.
      </Text>
      <Notice>
        {synthetic ? "Use the generated PNG for this review. " : ""}
        The service fails closed when its safety scanner is unavailable. No raw
        upload is served through the gallery.
      </Notice>
      {props.contributionsAllowed === false && (
        <Notice tone="warning">
          Photo contributions are currently held or awaiting a current privilege
          check. Existing private upload records stay retained. Refresh after a
          manager reinstates the privilege.
        </Notice>
      )}
      {synthetic && (
        <Button
          label="Choose generated PNG"
          testID="media-generated-image"
          variant="secondary"
          disabled={
            busy ||
            retainedAction ||
            !target ||
            props.contributionsAllowed === false
          }
          onPress={() => {
            setImage(generatedFictionalImage());
            setReceipt(null);
            setError(null);
          }}
        />
      )}
      {allowLibraryPicker && (
        <>
          <Button
            label="Choose a local JPEG, PNG or HEIC"
            variant="secondary"
            disabled={
              busy ||
              retainedAction ||
              !target ||
              props.contributionsAllowed === false
            }
            onPress={() =>
              void run(async () => {
                const picked = await pickMediaImage();
                if (picked) setImage(picked);
              })
            }
          />
          {Platform.OS === "android" && (
            <Button
              label="Review a picker result after Android activity recovery"
              variant="quiet"
              disabled={
                busy ||
                retainedAction ||
                !target ||
                props.contributionsAllowed === false
              }
              onPress={() =>
                void run(async () => {
                  const picked = await recoverPickedMediaImage();
                  if (picked) setImage(picked);
                  else setPhase("No recovered image is waiting.");
                })
              }
            />
          )}
        </>
      )}
      {image && (
        <>
          <Image
            source={{ uri: image.uri }}
            style={s.preview}
            accessibilityLabel={image.label}
          />
          <Text style={s.muted}>
            {image.label} · {image.bytes.byteLength} bytes · {image.mimeType}
          </Text>
        </>
      )}
      <TextInput
        style={s.input}
        value={caption}
        onChangeText={setCaption}
        editable={!busy && !retainedAction}
        maxLength={160}
        placeholder="Optional caption · avoid personal details"
        placeholderTextColor={colors.inkMuted}
        accessibilityLabel="Connected image caption"
      />
      <View style={s.row}>
        <Text style={[s.body, { flex: 1 }]}>
          {synthetic
            ? "I reviewed this image and the content rules."
            : "I reviewed this image and the content rules."}
        </Text>
        <Switch
          accessibilityLabel="Connected image policy acknowledgement"
          value={acknowledged}
          onValueChange={setAcknowledged}
          disabled={busy || retainedAction}
        />
      </View>
      <Button
        label="Upload privately and request processing"
        testID="media-upload-image"
        disabled={
          busy ||
          !target ||
          !image ||
          !acknowledged ||
          retainedAction ||
          props.contributionsAllowed === false
        }
        onPress={() =>
          void run(async () => {
            // Capture before hashing: an awaited digest must never retarget the original click.
            const captured = captureAlbumUploadTarget(
              albumScope,
              matches,
              selection,
              allowed,
            );
            const bytes = Uint8Array.from(image!.bytes);
            const snapshot = { ...image!, bytes };
            const draft: UploadJob = {
              target: captured,
              requestId: randomUUID(),
              image: snapshot,
              sha256: "",
              caption,
            };
            setRetained(draft);
            const hash = new Uint8Array(
              await Crypto.digest(
                Crypto.CryptoDigestAlgorithm.SHA256,
                bytes.buffer,
              ),
            );
            assertCurrent(draft);
            const sha256 = [...hash]
              .map((value) => value.toString(16).padStart(2, "0"))
              .join("");
            await execute({ ...draft, sha256 });
          })
        }
      />
      {phase && (
        <Text accessibilityLiveRegion="polite" style={s.body}>
          {phase}
        </Text>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {retainedAction && (
        <>
          <Button
            label="Retry the retained upload request"
            variant="secondary"
            disabled={busy || props.contributionsAllowed === false}
            onPress={() => {
              const job = retained.current;
              if (job)
                void run(async () => {
                  if (!job.sha256) {
                    const hash = new Uint8Array(
                      await Crypto.digest(
                        Crypto.CryptoDigestAlgorithm.SHA256,
                        Uint8Array.from(job.image.bytes).buffer,
                      ),
                    );
                    assertCurrent(job);
                    job.sha256 = [...hash]
                      .map((value) => value.toString(16).padStart(2, "0"))
                      .join("");
                  }
                  await execute(job);
                });
            }}
          />
          <Button
            label="Close retained upload; keep private record"
            testID="media-close-retained"
            variant="quiet"
            disabled={busy}
            onPress={() => {
              setRetained(null);
              setImage(null);
              setAcknowledged(false);
              setPhase(
                "The in-memory upload request was closed. Any private server record remains private.",
              );
              setError(null);
            }}
          />
          <Text style={s.muted}>
            Retry keeps the original game, upload identity and bytes. Closing
            this screen clears the in-memory write capability; the private
            server record remains.
          </Text>
        </>
      )}
      {receipt && (
        <Text style={s.muted}>
          Service receipt: {receipt.photoId} · revision{" "}
          {receipt.displayRevision} · {receipt.width} × {receipt.height}. This
          is processing acknowledgement, not photo publication.
        </Text>
      )}
      <Button
        label="Refresh my connected upload statuses"
        testID="media-refresh-uploads"
        variant="quiet"
        disabled={busy}
        onPress={() => void run(refresh)}
      />
      {uploads !== null && uploads.length === 0 && (
        <Text style={s.muted}>
          No connected uploads for this account and season.
        </Text>
      )}
      {uploads?.map((upload) => (
        <View key={upload.uploadId} style={s.uploadRow}>
          <Text style={s.label}>
            {upload.status} · revision {upload.displayRevision}
          </Text>
          <Text style={s.muted}>
            {upload.byteSize} bytes
            {upload.failureCode ? ` · ${upload.failureCode}` : ""}
          </Text>
          {upload.status === "linked" && (
            <Button
              label="View my current private derivative"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  const bytes = await client.image(
                    upload.photoId,
                    upload.displayRevision,
                  );
                  if (alive.current)
                    setPrivateImage(
                      `data:image/jpeg;base64,${standardBase64(bytes)}`,
                    );
                })
              }
            />
          )}
        </View>
      ))}
      {privateImage && (
        <>
          <Image
            source={{ uri: privateImage, cache: "reload" }}
            style={s.privatePreview}
            accessibilityLabel="Current private derivative fetched after an authenticated access check"
          />
          <Button
            label="Close private derivative"
            variant="quiet"
            onPress={() => setPrivateImage(null)}
          />
          <Text style={s.muted}>
            Held in memory while displayed. Current access is checked on each
            image fetch; removal cannot recall an existing screenshot.
          </Text>
        </>
      )}
    </Card>
  );
}
const s = StyleSheet.create({
  heading: {
    color: colors.ink,
    fontSize: 21,
    lineHeight: 28,
    fontWeight: "700",
  },
  body: { color: colors.ink, fontSize: 16, lineHeight: 24 },
  muted: { color: colors.inkMuted, fontSize: 14, lineHeight: 21 },
  label: { color: colors.ink, fontSize: 15, lineHeight: 22, fontWeight: "600" },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    backgroundColor: colors.surface,
    color: colors.ink,
    padding: 12,
    fontSize: 16,
  },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12 },
  preview: {
    width: "100%",
    height: 140,
    resizeMode: "contain",
    backgroundColor: colors.bench,
  },
  privatePreview: {
    width: "100%",
    height: 220,
    resizeMode: "contain",
    backgroundColor: colors.bench,
  },
  uploadRow: {
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
});
