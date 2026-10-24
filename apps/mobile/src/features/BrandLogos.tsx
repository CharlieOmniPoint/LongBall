import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";
import type {
  BrandingCommand,
  BrandingDto,
  BrandKind,
  BrandAssetView,
} from "@longball/application/branding";
import {
  BrandMediaClient,
  logoReferenceKey,
  type LogoUploadTarget,
  type PreparedLogoUpload,
} from "../platform/brand-media-client";
import type { LocalUploadImage } from "../platform/media-client";
import {
  generatedFictionalImage,
  pickMediaImage,
  recoverPickedMediaImage,
} from "../platform/media-picker";
import { randomUUID } from "../platform/id";
import { AuthenticatedBrandBadge } from "./BrandBadge";
import { Button, Card, colors, Notice, Pill, typography } from "../ui";

export interface BrandLogosProps {
  value: BrandingDto;
  client: BrandMediaClient;
  scopeKey: string;
  assertAccess: () => Promise<void>;
  disabled: boolean;
  synthetic: boolean;
  onChange: (command: BrandingCommand) => Promise<boolean>;
  onChanged: () => void | Promise<void>;
  onRetainedChange: (retained: boolean, scopeKey: string) => void;
}
interface UploadJob {
  scopeKey: string;
  target: LogoUploadTarget;
  requestId: string;
  image: LocalUploadImage;
  sha256: string;
  prepared?: PreparedLogoUpload;
}
const kindLabel = (kind: BrandKind) =>
  kind === "club_logo" ? "club logo" : "team logo";
const writable = (value: BrandingDto, kind: BrandKind) =>
  kind === "club_logo" ? value.canWriteClub : value.canWriteTeam;
const slot = (value: BrandingDto, kind: BrandKind) =>
  kind === "club_logo" ? value.club : value.team;
function LogoAcknowledgement({
  label,
  accessibilityLabel,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  accessibilityLabel: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={[styles.acknowledgement, disabled && styles.disabled]}
    >
      <Text style={[typography.body, styles.flex]}>{label}</Text>
      <View
        accessible={false}
        aria-hidden
        style={[styles.toggleTrack, value && styles.toggleSelected]}
      >
        <View
          style={[styles.toggleThumb, value && styles.toggleThumbSelected]}
        />
      </View>
    </Pressable>
  );
}
export function BrandLogos(props: BrandLogosProps) {
  return <BrandLogosContent key={props.scopeKey} {...props} />;
}
function BrandLogosContent(props: BrandLogosProps) {
  const {
    value,
    client,
    scopeKey,
    disabled,
    synthetic,
    assertAccess,
    onChange,
    onChanged,
  } = props;
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  });
  const alive = useRef(true),
    running = useRef(false),
    retained = useRef<UploadJob | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      live.current.onRetainedChange(false, scopeKey);
    };
  }, [scopeKey]);
  const [kind, setKind] = useState<BrandKind>(
    value.canWriteClub ? "club_logo" : "team_logo",
  );
  const [image, setImage] = useState<LocalUploadImage | null>(null),
    [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false),
    [hasRetained, setHasRetained] = useState(false);
  const [phase, setPhase] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{
    command: BrandingCommand;
    asset: BrandAssetView | null;
  } | null>(null);
  const [rights, setRights] = useState(false),
    [viewed, setViewed] = useState<string | null>(null);
  const keep = (job: UploadJob | null) => {
    retained.current = job;
    setHasRetained(Boolean(job));
    live.current.onRetainedChange(Boolean(job), scopeKey);
  };
  const guard = async (job: UploadJob) => {
    await live.current.assertAccess();
    const current = live.current;
    if (
      !alive.current ||
      job.scopeKey !== current.scopeKey ||
      !writable(current.value, job.target.kind) ||
      (job.target.kind === "club_logo"
        ? job.target.clubId !== current.value.clubId
        : job.target.teamId !== current.value.teamId)
    )
      throw new Error(
        "This retained logo upload belongs to a different or no longer authorised scope. It was not retargeted.",
      );
  };
  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The logo request was not confirmed. Its original identity is retained.",
        );
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const execute = async (original: UploadJob) => {
    let job = original;
    await guard(job);
    if (!job.sha256) {
      setPhase("Checking the exact selected logo bytes…");
      const hash = new Uint8Array(
        await Crypto.digest(
          Crypto.CryptoDigestAlgorithm.SHA256,
          Uint8Array.from(job.image.bytes).buffer,
        ),
      );
      await guard(job);
      job = {
        ...job,
        sha256: [...hash]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      };
      keep(job);
    }
    if (!job.prepared) {
      setPhase("Preparing a private logo upload…");
      const prepared = await client.prepare({
        requestId: job.requestId,
        target: job.target,
        image: job.image,
        sha256: job.sha256,
      });
      await guard(job);
      job = { ...job, prepared };
      keep(job);
    }
    setPhase("Uploading the captured logo to private quarantine…");
    await client.upload(job.prepared!, job.image, job.requestId);
    await guard(job);
    setPhase("Scanning and creating metadata-free logo derivatives…");
    await client.complete(job.prepared!, job.requestId);
    await guard(job);
    keep(null);
    setImage(null);
    setAcknowledged(false);
    setPhase(
      "Processed privately. Review the exact derivative and confirm rights before publishing it as a logo.",
    );
    await onChanged();
  };
  const locked = disabled || busy || hasRetained;
  const choose = (next: BrandKind) => {
    if (locked) return;
    setKind(next);
    setImage(null);
    setAcknowledged(false);
    setError(null);
    setPhase(null);
  };
  const assetCurrent = review?.asset
    ? value.assets.some(
        (asset) =>
          logoReferenceKey(asset) === logoReferenceKey(review.asset!) &&
          ["processed", "published"].includes(asset.status),
      )
    : true;
  return (
    <View style={styles.stack} testID="brand-logos">
      <Card>
        <Text style={typography.section}>Club and team logos</Text>
        <View style={styles.row}>
          <AuthenticatedBrandBadge
            client={client}
            reference={value.effective.logo}
            scopeKey={scopeKey}
            assertAccess={assertAccess}
            label={`${value.team.name} current ${value.effective.source} badge`}
            size={64}
          />
          <View style={styles.flex}>
            <Text style={typography.label}>
              {value.team.name} {value.team.ageGroup}
            </Text>
            <Text style={typography.body}>
              {value.effective.source === "team"
                ? "Team logo override"
                : value.effective.source === "club"
                  ? "Inherits the current club logo"
                  : "Neutral original badge"}
            </Text>
          </View>
        </View>
        <Text style={typography.muted}>
          A team override stays in place when the club logo changes. Removing
          that override restores club inheritance, then the neutral badge if the
          club has no logo.
        </Text>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={typography.label}>{value.club.name} · club logo</Text>
            <Text style={typography.muted}>
              Slot version {value.club.slotVersion}
            </Text>
          </View>
          <AuthenticatedBrandBadge
            client={client}
            reference={value.club.logo}
            scopeKey={scopeKey}
            assertAccess={assertAccess}
            label={`${value.club.name} club logo`}
          />
        </View>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={typography.label}>Team override</Text>
            <Text style={typography.muted}>
              {value.team.logo
                ? `Recorded · slot version ${value.team.slotVersion}`
                : "None · current club logo is inherited"}
            </Text>
          </View>
          <AuthenticatedBrandBadge
            client={client}
            reference={value.team.logo}
            scopeKey={scopeKey}
            assertAccess={assertAccess}
            label={`${value.team.name} team override`}
          />
        </View>
        {!value.canWriteClub && !value.canWriteTeam && (
          <Notice>
            Your current role can view the effective logo. A club administrator
            changes the club logo; an assigned manager changes the team
            override.
          </Notice>
        )}
        {value.canWriteClub && (
          <Notice>
            Club administrator context. Choose your manager assignment
            separately to change a team logo.
          </Notice>
        )}
        {value.canWriteTeam && (
          <Notice>
            Assigned manager context. Club logo publication requires a separate
            club administrator assignment.
          </Notice>
        )}
      </Card>
      {(value.canWriteClub || value.canWriteTeam) && (
        <>
          {review ? (
            <Card>
              <Text style={typography.section}>
                {review.command.type === "logo.published"
                  ? `Review ${kindLabel(review.command.kind)} publication`
                  : `Review ${kindLabel(review.command.kind)} removal`}
              </Text>
              {review.asset ? (
                <>
                  <AuthenticatedBrandBadge
                    client={client}
                    reference={review.asset}
                    scopeKey={scopeKey}
                    assertAccess={assertAccess}
                    label={`Processed ${kindLabel(review.asset.kind)} revision ${review.asset.revision} for rights review`}
                    size={176}
                    mode="own"
                    onViewed={setViewed}
                    showError
                  />
                  <Text style={typography.body}>
                    Revision {review.asset.revision} · {review.asset.width} ×{" "}
                    {review.asset.height} · {kindLabel(review.asset.kind)} for{" "}
                    {review.asset.kind === "club_logo"
                      ? value.club.name
                      : value.team.name}
                    .
                  </Text>
                  <LogoAcknowledgement
                    label="I reviewed this exact processed logo and confirm the right to use it."
                    accessibilityLabel="Logo rights and exact revision reviewed"
                    value={rights}
                    onValueChange={setRights}
                    disabled={locked}
                  />
                  <Text style={typography.muted}>
                    Publishing changes only this owning logo reference. It does
                    not publish a game photo or grant another role.
                  </Text>
                </>
              ) : (
                <Notice tone="warning">
                  {review.command.kind === "team_logo"
                    ? "Remove the team override and use the current club logo, or the neutral original badge if none is supplied."
                    : "Remove the club logo. Teams with their own overrides keep them; other teams return to the neutral original badge."}{" "}
                  Players, lineups and match records are unchanged. The retained
                  asset is not deleted.
                </Notice>
              )}
              <Button
                label={
                  review.command.type === "logo.published"
                    ? `Publish this reviewed ${kindLabel(review.command.kind)}`
                    : review.command.kind === "team_logo"
                      ? "Confirm removal; restore club inheritance"
                      : "Confirm removal of club logo"
                }
                testID="brand-confirm"
                variant={
                  review.command.type === "logo.removed" ? "danger" : "primary"
                }
                disabled={
                  locked ||
                  !writable(value, review.command.kind) ||
                  review.command.expectedSlotVersion !==
                    slot(value, review.command.kind).slotVersion ||
                  !assetCurrent ||
                  (review.asset !== null &&
                    (!rights || viewed !== logoReferenceKey(review.asset)))
                }
                onPress={() => {
                  const command = review.command;
                  void run(async () => {
                    await assertAccess();
                    const saved = await onChange(command);
                    if (alive.current && saved) {
                      setReview(null);
                      setRights(false);
                      setViewed(null);
                    }
                  });
                }}
              />
              <Button
                label="Close logo review"
                variant="quiet"
                disabled={busy || hasRetained}
                onPress={() => {
                  setReview(null);
                  setRights(false);
                  setViewed(null);
                }}
              />
            </Card>
          ) : (
            <>
              <Card>
                <Text style={typography.section}>Upload a logo</Text>
                <View style={styles.row}>
                  {value.canWriteClub && (
                    <Button
                      label="Club logo"
                      testID="brand-kind-club_logo"
                      variant={kind === "club_logo" ? "primary" : "secondary"}
                      disabled={locked}
                      onPress={() => choose("club_logo")}
                    />
                  )}
                  {value.canWriteTeam && (
                    <Button
                      label="Team logo"
                      testID="brand-kind-team_logo"
                      variant={kind === "team_logo" ? "primary" : "secondary"}
                      disabled={locked}
                      onPress={() => choose("team_logo")}
                    />
                  )}
                </View>
                <Text style={typography.body}>
                  Target: {kindLabel(kind)} for{" "}
                  {kind === "club_logo" ? value.club.name : value.team.name}.
                  Logos belong to their club or team across seasons, with no
                  match association.
                </Text>
                <Notice>
                  Logo files stay private until scanning, safe derivative
                  processing and explicit publication succeed. If scanning is
                  unavailable, the current visible badge stays unchanged.
                </Notice>
                {synthetic ? (
                  <Button
                    label="Choose generated logo PNG"
                    testID="brand-generated-image"
                    variant="secondary"
                    disabled={locked}
                    onPress={() => {
                      setImage(generatedFictionalImage());
                      setError(null);
                    }}
                  />
                ) : (
                  <>
                    <Button
                      label="Choose a logo JPEG, PNG or HEIC"
                      testID="brand-pick-image"
                      variant="secondary"
                      disabled={locked}
                      onPress={() =>
                        void run(async () => {
                          const picked = await pickMediaImage();
                          await live.current.assertAccess();
                          if (alive.current && picked) setImage(picked);
                        })
                      }
                    />
                    {Platform.OS === "android" && (
                      <Button
                        label="Review a recovered logo picker result"
                        variant="quiet"
                        disabled={locked}
                        onPress={() =>
                          void run(async () => {
                            const picked = await recoverPickedMediaImage();
                            await live.current.assertAccess();
                            if (alive.current && picked) setImage(picked);
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
                      accessibilityLabel="Selected local logo, still private"
                      style={styles.preview}
                    />
                    <Text style={typography.muted}>
                      {image.bytes.byteLength} bytes · {image.mimeType}
                    </Text>
                  </>
                )}
                <LogoAcknowledgement
                  label="I checked this logo image and the upload rules."
                  accessibilityLabel="Logo upload policy acknowledgement"
                  value={acknowledged}
                  onValueChange={setAcknowledged}
                  disabled={locked}
                />
                <Button
                  label="Upload logo privately for processing"
                  testID="brand-upload"
                  disabled={
                    locked || !writable(value, kind) || !image || !acknowledged
                  }
                  onPress={() => {
                    if (running.current || !image || !writable(value, kind))
                      return;
                    const target: LogoUploadTarget =
                      kind === "club_logo"
                        ? { kind, clubId: value.clubId }
                        : { kind, teamId: value.teamId };
                    const captured: UploadJob = {
                      scopeKey,
                      target,
                      requestId: randomUUID(),
                      image: { ...image, bytes: Uint8Array.from(image.bytes) },
                      sha256: "",
                    };
                    // Bind ownership and bytes before any awaited digest, token read or request.
                    keep(captured);
                    void run(() => execute(captured));
                  }}
                />
                {phase && (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={typography.body}
                  >
                    {phase}
                  </Text>
                )}
                {error && <Notice tone="error">{error}</Notice>}
                {hasRetained && (
                  <>
                    <Pill tone="warning">
                      PRIVATE REQUEST RETAINED · VISIBLE LOGO UNCHANGED
                    </Pill>
                    <Button
                      label="Retry exact retained logo upload"
                      testID="brand-retry-upload"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        const job = retained.current;
                        if (job) void run(() => execute(job));
                      }}
                    />
                    <Button
                      label="Close retained logo upload; keep private record"
                      testID="brand-close-retained"
                      variant="quiet"
                      disabled={busy}
                      onPress={() => {
                        keep(null);
                        setImage(null);
                        setAcknowledged(false);
                        setError(null);
                        setPhase(
                          "The in-memory upload capability was closed. Private service metadata remains; no logo was published.",
                        );
                      }}
                    />
                  </>
                )}
              </Card>
              <Card>
                <Text style={typography.section}>
                  My authorised logo uploads
                </Text>
                {!value.assets.length && (
                  <Text style={typography.muted}>
                    No logo uploads are currently available in this account and
                    owner scope.
                  </Text>
                )}
                {value.assets.map((asset) => (
                  <View key={logoReferenceKey(asset)} style={styles.asset}>
                    <Text style={typography.label}>
                      {kindLabel(asset.kind)} · revision {asset.revision}
                    </Text>
                    <Pill
                      tone={asset.status === "published" ? "brand" : "muted"}
                    >
                      {asset.status}
                    </Pill>
                    <Text style={typography.muted}>
                      {asset.byteSize} bytes
                      {asset.width && asset.height
                        ? ` · ${asset.width} × ${asset.height}`
                        : ""}
                    </Text>
                    {["processed", "published"].includes(asset.status) &&
                    writable(value, asset.kind) ? (
                      <Button
                        label={`Review ${kindLabel(asset.kind)} revision ${asset.revision}`}
                        testID={`brand-review-${asset.assetId}-${asset.revision}`}
                        variant="secondary"
                        disabled={locked}
                        onPress={() => {
                          setRights(false);
                          setViewed(null);
                          setReview({
                            asset,
                            command: {
                              id: randomUUID(),
                              type: "logo.published",
                              kind: asset.kind,
                              assetId: asset.assetId,
                              reviewedRevision: asset.revision,
                              expectedSlotVersion: slot(value, asset.kind)
                                .slotVersion,
                              confirmRightsToUse: true,
                              policyVersion: value.policyVersion,
                            },
                          });
                        }}
                      />
                    ) : (
                      <Text style={typography.muted}>
                        Private processing must finish before this revision can
                        be reviewed and published.
                      </Text>
                    )}
                  </View>
                ))}
                <Button
                  label="Refresh authorised logo choices"
                  testID="brand-refresh"
                  variant="quiet"
                  disabled={locked}
                  onPress={() =>
                    void run(async () => {
                      await assertAccess();
                      await onChanged();
                    })
                  }
                />
              </Card>
              <Card>
                <Text style={typography.section}>Remove a logo reference</Text>
                {(["club_logo", "team_logo"] as const)
                  .filter((item) => writable(value, item))
                  .map((item) => (
                    <Button
                      key={item}
                      label={
                        item === "team_logo"
                          ? "Review removing team override"
                          : "Review removing club logo"
                      }
                      testID={`brand-remove-${item}`}
                      variant="secondary"
                      disabled={locked || slot(value, item).logo === null}
                      onPress={() =>
                        setReview({
                          asset: null,
                          command: {
                            id: randomUUID(),
                            type: "logo.removed",
                            kind: item,
                            expectedSlotVersion: slot(value, item).slotVersion,
                          },
                        })
                      }
                    />
                  ))}
              </Card>
            </>
          )}
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 12,
  },
  flex: { flex: 1, minWidth: 140 },
  acknowledgement: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    minWidth: 44,
    paddingVertical: 6,
  },
  disabled: { opacity: 0.5 },
  toggleTrack: {
    width: 40,
    height: 24,
    padding: 2,
    borderRadius: 12,
    backgroundColor: colors.controlBorder,
  },
  toggleSelected: { backgroundColor: colors.brand },
  toggleThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#fff",
  },
  toggleThumbSelected: { alignSelf: "flex-end" },
  preview: {
    width: "100%",
    height: 150,
    resizeMode: "contain",
    backgroundColor: colors.bench,
  },
  asset: {
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
});
