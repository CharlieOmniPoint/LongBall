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
  type MediaAuthenticatedFetch,
} from "../platform/media-client";
import { Button, Card, colors, Notice } from "../ui";

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
  authenticatedFetch?: MediaAuthenticatedFetch;
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
    authenticatedFetch,
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
  const [showDetails, setShowDetails] = useState(false);
  const chooseImage = (picked: LocalUploadImage) => {
    setImage(picked);
    setReceipt(null);
    setPhase(null);
    setError(null);
    setAcknowledged(false);
  };
  const client = useMemo(
    () =>
      new MediaUploadClient(apiBaseUrl, actor, async (url, options) => {
        const absolute =
          url.startsWith("/") && Platform.OS === "web"
            ? new URL(url, globalThis.location.origin).toString()
            : url;
        if (authenticatedFetch) return authenticatedFetch(absolute, options);
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
    [apiBaseUrl, actor, synthetic, authenticatedFetch],
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
      setPhase("Preparing your photo…");
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
    setPhase("Uploading your photo privately…");
    await client.upload(job.prepared!, job.image, job.requestId);
    assertCurrent(job);
    setPhase(
      "Checking your photo before it can be shared…",
    );
    const processed = await client.complete(job.prepared!, job.requestId);
    assertCurrent(job);
    setReceipt(processed);
    setRetained(null);
    setPhase(
      actor.role === "manager"
        ? "Your photo is ready and private. Review it in your submissions, then choose Publish when you are ready."
        : "Your photo is ready for your manager to review. The team cannot see it until it is approved.",
    );
    await refresh();
    await onChanged?.();
  };
  if (actor.role === "spectator")
    return (
      <Card>
        <Text style={s.heading}>Team photos</Text>
        <Notice>
          Spectators can view shared team photos. Uploading is available to players and managers.
        </Notice>
      </Card>
    );
  return (
    <Card>
      <Text style={s.heading}>Add a photo</Text>
      <Notice>
        {target
          ? `For ${target.label}`
          : "Choose a game album above before adding a photo."}
      </Notice>
      <Text style={s.body}>
        {actor.role === "manager" ? "Your photo stays private until you review it and choose Publish." : "Your manager checks your photo before the team can see it."}
      </Text>
      {props.contributionsAllowed === false && (
        <Notice tone="warning">
          Adding photos is currently unavailable for this account. Your existing private uploads are kept. Check with your manager, then refresh.
        </Notice>
      )}
      {synthetic && (
        <Button
          label="Use a football picture"
          testID="media-generated-image"
          variant="secondary"
          disabled={
            busy ||
            retainedAction ||
            !target ||
            props.contributionsAllowed === false
          }
          onPress={() => {
            chooseImage(generatedFictionalImage());
          }}
        />
      )}
      {allowLibraryPicker && (
        <>
          <Button
            label="Choose a photo"
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
                if (picked) chooseImage(picked);
              })
            }
          />
          {Platform.OS === "android" && (
            <Button
              label="Recover my last photo selection"
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
                  if (picked) chooseImage(picked);
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
            {image.label}
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
        accessibilityLabel="Photo caption"
        testID="media-caption"
      />
      <View style={s.row}>
        <Text style={[s.body, { flex: 1 }]}>
          I checked this photo and the team’s photo rules.
        </Text>
        <Switch
          accessibilityLabel="I checked this photo and the team’s photo rules"
          testID="media-policy-acknowledgement"
          value={acknowledged}
          onValueChange={setAcknowledged}
          disabled={busy || retainedAction}
        />
      </View>
      <Button
        label={actor.role === "manager" ? "Upload photo privately" : "Submit for manager review"}
        testID="media-upload-image"
        disabled={
          busy ||
          !target ||
          !image ||
          !acknowledged ||
          receipt !== null ||
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
            label="Retry this photo upload"
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
            label="Close this upload; keep any private copy"
            testID="media-close-retained"
            variant="quiet"
            disabled={busy}
            onPress={() => {
              setRetained(null);
              setImage(null);
              setAcknowledged(false);
              setPhase(
                "This upload is closed on this screen. Any copy already received stays private.",
              );
              setError(null);
            }}
          />
          <Text style={s.muted}>
            Retry sends the same photo for the same game. Closing stops retries from this screen; any copy already received stays private.
          </Text>
        </>
      )}
      <Button label="Photo details" compact variant="quiet" testID="media-upload-details" accessibilityState={{ expanded: showDetails }} onPress={() => setShowDetails(value => !value)} />
      {showDetails && <View style={{ gap: 8 }} testID="media-upload-detail-content">
        <Text style={s.muted}>JPEG, PNG and HEIC photos can be up to 15 MiB. Photos are checked before they can be shared. If safety checks are unavailable, the photo stays private.</Text>
        {image && <Text style={s.muted}>Selected file: {image.bytes.byteLength} bytes · {image.mimeType}</Text>}
      {receipt && (
        <Text style={s.muted}>
          Service receipt: {receipt.photoId} · revision{" "}
          {receipt.displayRevision} · {receipt.width} × {receipt.height}. This
          is processing acknowledgement, not photo publication.
        </Text>
      )}
      </View>}
      <Button
        label="Refresh my uploads"
        testID="media-refresh-uploads"
        variant="quiet"
        disabled={busy}
        onPress={() => void run(refresh)}
      />
      {uploads !== null && uploads.length === 0 && (
        <Text style={s.muted}>
          No uploads yet for this team and season.
        </Text>
      )}
      {uploads?.map((upload) => (
        <View key={upload.uploadId} style={s.uploadRow}>
          <Text style={s.label}>
            {upload.status === "linked" ? "Photo received" : upload.status === "prepared" ? "Waiting to upload" : upload.status === "uploaded" ? "Waiting for photo checks" : upload.status === "processed" ? "Photo checked" : upload.status.replaceAll("_", " ")}
          </Text>
          {showDetails && <Text style={s.muted}>
            {upload.byteSize} bytes
            {upload.failureCode ? ` · ${upload.failureCode}` : ""}
            {` · revision ${upload.displayRevision}`}
          </Text>}
          {upload.status === "linked" && (
            <Button
              label="View my private photo"
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
            accessibilityLabel="Your private photo"
          />
          <Button
            label="Close private photo"
            variant="quiet"
            onPress={() => setPrivateImage(null)}
          />
          <Text style={s.muted}>
            {actor.role === "manager" ? "This preview is private. Choose Publish to share the photo with the team." : "Your photo is private to your account and team managers until it is approved."} A screenshot or a copy saved outside LongBall cannot be recalled.
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
