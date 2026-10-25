import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { Allocation } from "@longball/domain";
import {
  latestMatchPlans,
  previewMatchPlan,
  saveMatchPlan,
  type MatchPlanSettings,
} from "@longball/application/match-plans";
import {
  goalkeeperChoice,
  type PreparationCommand,
  type PreparationFixture,
  type PreparationState,
} from "@longball/application/preparation";
import { randomUUID } from "../platform/id";
import { useDraftSignal } from "../platform/use-unsaved-draft";
import { Button, Card, Notice, typography } from "../ui";
type Payload = PreparationCommand extends infer Command
  ? Command extends PreparationCommand
    ? Omit<Command, "id" | "expectedRevision">
    : never
  : never;
/** Reusable plans are manager-reviewed proposals, not attendance or accepted live events. */
export function ReusableMatchPlans({
  state,
  fixture,
  busy,
  onCommand,
  onPrepare,
  onDraftChange,
}: {
  state: PreparationState;
  fixture: PreparationFixture;
  busy: boolean;
  onCommand: (command: Payload) => Promise<boolean>;
  onPrepare: () => Promise<boolean>;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const [allocations, setAllocations] = useState<Allocation[]>([]),
    [slotId, setSlotId] = useState<string | null>(null);
  const [minimum, setMinimum] = useState("5"),
    [batch, setBatch] = useState("2"),
    [threshold, setThreshold] = useState("4"),
    [buffer, setBuffer] = useState("15"),
    [returnToNormal, setReturn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<ReturnType<
    typeof previewMatchPlan
  > | null>(null);
  const dirty =
    open &&
    (name !== "" ||
      description !== "" ||
      allocations.length > 0 ||
      minimum !== "5" ||
      batch !== "2" ||
      threshold !== "4" ||
      buffer !== "15" ||
      returnToNormal !== null);
  useDraftSignal(dirty, onDraftChange);
  const resetDraft = () => {
    setName("");
    setDescription("");
    setAllocations([]);
    setSlotId(null);
    setMinimum("5");
    setBatch("2");
    setThreshold("4");
    setBuffer("15");
    setReturn(null);
    setOpen(false);
  };
  const source = state.snapshots
    .filter((snapshot) => snapshot.fixtureId === fixture.id)
    .at(-1);
  const selected = fixture.selectedProfileIds
    .map((id) =>
      state.profiles.find((profile) => profile.id === id && profile.active),
    )
    .filter((profile): profile is NonNullable<typeof profile> =>
      Boolean(profile),
    );
  const keepers = selected.filter((profile) => goalkeeperChoice(profile) > 0),
    plans = latestMatchPlans(state);
  const label = (id: string) =>
    state.profiles.find(
      (profile) =>
        profile.playerId === id && profile.seasonId === fixture.seasonId,
    )?.displayName ?? "Player unavailable";
  const settings = (): MatchPlanSettings => {
    if (returnToNormal === null)
      throw new Error("Choose the return-to-normal option explicitly.");
    return {
      payload: {
        keeperMode: keepers.length === 1 ? "sole_fixed" : "common_pool",
        fixedKeeperPlayerSeasonId:
          keepers.length === 1 ? keepers[0].playerId : null,
        minimumStintMs: Number(minimum) * 60_000,
        batchLimit: Number(batch),
        scoreLeadThreshold: Number(threshold),
        returnToNormalEnabled: returnToNormal,
      },
      applicability: {
        minimumStint: "soft_preference",
        batchLimit: "soft_preference",
        q07: "unapproved",
      },
      softPreferences: { halfBufferFraction: Number(buffer) / 100 },
    };
  };
  const field = (
    title: string,
    value: string,
    change: (value: string) => void,
    numeric = false,
  ) => (
    <View style={{ gap: 5 }}>
      <Text style={typography.label}>{title}</Text>
      <TextInput
        accessibilityLabel={title}
        value={value}
        onChangeText={change}
        editable={!busy}
        keyboardType={numeric ? "decimal-pad" : "default"}
        style={{
          minHeight: 48,
          padding: 12,
          borderWidth: 1,
          borderColor: "#6F807A",
          borderRadius: 8,
        }}
      />
    </View>
  );
  const freshReview = review?.plan
    ? previewMatchPlan(state, review.plan.id, fixture.id)
    : null;
  return (
    <Card>
      <View style={{ gap: 12 }} testID="reusable-match-plans">
        <Text style={typography.section}>Advanced match plans</Text>
        <Text style={typography.body}>
          Optionally save a starting lineup with proposed match settings from
          reviewed preparation. Copy them into another unplayed fixture only
          after reviewing its current selected players. Replies, check-in and
          recorded matches are never copied. For a simple lineup without policy
          settings, use Saved player setups.
        </Text>
        {error && <Notice tone="error">{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}
        <Button
          label={
            open
              ? dirty
                ? "Discard match-plan draft and close"
                : "Close match-plan editor"
              : "Save a reusable match plan from this fixture"
          }
          variant="secondary"
          disabled={busy}
          onPress={() => {
            if (open) resetDraft();
            else setOpen(true);
            setError(null);
          }}
        />
        {open && (
          <>
            {!source ? (
              <>
                <Notice>
                  Save this fixture’s preparation before choosing a reusable
                  lineup.
                </Notice>
                <Button
                  label="Save preparation for match-plan review"
                  disabled={busy}
                  onPress={() => {
                    void onPrepare();
                  }}
                />
              </>
            ) : (
              <>
                <Text style={typography.muted}>
                  Reviewed source: {fixture.opponent} · preparation revision{" "}
                  {source.preparedRevision}. Choose every place explicitly; this
                  proposal does not mark anyone present.
                </Text>
                {field("Reusable plan name", name, setName)}
                {field(
                  "Reusable plan description (optional, no sensitive details)",
                  description,
                  setDescription,
                )}
                {source.formation.slots.map((slot) => (
                  <Button
                    key={slot.id}
                    label={`${slot.label} · ${allocations.find((row) => row.slotId === slot.id) ? label(allocations.find((row) => row.slotId === slot.id)!.playerId) : "Choose player"}`}
                    variant={slotId === slot.id ? "primary" : "secondary"}
                    disabled={busy}
                    onPress={() => setSlotId(slot.id)}
                  />
                ))}
                {slotId && (
                  <View style={{ gap: 8 }}>
                    <Text style={typography.label}>
                      Choose for{" "}
                      {
                        source.formation.slots.find(
                          (slot) => slot.id === slotId,
                        )?.label
                      }
                    </Text>
                    {selected
                      .filter((profile) => {
                        const slot = source.formation.slots.find(
                          (row) => row.id === slotId,
                        )!;
                        return (
                          profile.eligiblePositions.includes(slot.position) &&
                          (slot.position !== "GK" ||
                            goalkeeperChoice(profile) > 0)
                        );
                      })
                      .map((profile) => (
                        <Button
                          key={profile.id}
                          label={`Plan ${profile.displayName}`}
                          variant="secondary"
                          disabled={busy}
                          onPress={() => {
                            const slot = source.formation.slots.find(
                              (row) => row.id === slotId,
                            )!;
                            setAllocations((value) => [
                              ...value.filter(
                                (row) =>
                                  row.slotId !== slotId &&
                                  row.playerId !== profile.playerId,
                              ),
                              {
                                slotId,
                                position: slot.position,
                                playerId: profile.playerId,
                              },
                            ]);
                            setSlotId(null);
                          }}
                        />
                      ))}
                  </View>
                )}
                <Text style={typography.label}>
                  Proposed settings · controller confirmation still required
                </Text>
                <Text style={typography.muted}>
                  {keepers.length === 1
                    ? `One fixed qualifying keeper: ${keepers[0].displayName}`
                    : `${keepers.length} qualifying keepers · shared common-pool proposal`}
                  . Q07 remains unapproved; this is not permission for a
                  keeper-policy transition.
                </Text>
                {field(
                  "Plan preferred spell (minutes)",
                  minimum,
                  setMinimum,
                  true,
                )}
                {field("Plan preferred batch size", batch, setBatch, true)}
                {field(
                  "Plan score-lead threshold",
                  threshold,
                  setThreshold,
                  true,
                )}
                {field("Plan half buffer (%)", buffer, setBuffer, true)}
                <Text style={typography.label}>
                  Return to normal when the lead falls?
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button
                    label="Plan return Yes"
                    variant={returnToNormal === true ? "primary" : "secondary"}
                    disabled={busy}
                    onPress={() => setReturn(true)}
                  />
                  <Button
                    label="Plan return No"
                    variant={returnToNormal === false ? "primary" : "secondary"}
                    disabled={busy}
                    onPress={() => setReturn(false)}
                  />
                </View>
                <Button
                  label="Review and save reusable plan"
                  disabled={busy}
                  testID="save-reusable-match-plan"
                  onPress={() => {
                    void (async () => {
                      try {
                        setError(null);
                        const input = {
                          planId: randomUUID(),
                          expectedPlanVersion: 0,
                          name,
                          description,
                          sourceFixtureId: fixture.id,
                          sourceSnapshotId: source.id,
                          allocations,
                          settings: settings(),
                        };
                        saveMatchPlan(state, input);
                        if (
                          await onCommand({
                            type: "match_plan.saved",
                            ...input,
                          })
                        ) {
                          setNotice(
                            "Reusable plan saved. Its source snapshot and match are unchanged.",
                          );
                          resetDraft();
                        }
                      } catch (cause) {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "The plan was not saved.",
                        );
                      }
                    })();
                  }}
                />
              </>
            )}
          </>
        )}
        <Text style={typography.label}>
          Plans saved in this team and season
        </Text>
        {!plans.length && (
          <Text style={typography.body}>No reusable match plans yet.</Text>
        )}
        {plans.map((plan) => (
          <View key={plan.id} style={{ gap: 7 }}>
            <Text style={typography.label}>
              {plan.name} · version {plan.version}
            </Text>
            {Boolean(plan.description) && (
              <Text style={typography.body}>{plan.description}</Text>
            )}
            <Button
              label={`Preview ${plan.name} for this fixture`}
              variant="secondary"
              disabled={busy}
              onPress={() => {
                setReview(previewMatchPlan(state, plan.id, fixture.id));
                setError(null);
                setNotice(null);
              }}
            />
          </View>
        ))}
        {review && (
          <View style={{ gap: 10 }} testID="match-plan-apply-preview">
            <Text style={typography.section}>
              Review plan for {fixture.opponent}
            </Text>
            {review.issues.map((issue) => (
              <Notice key={issue} tone="warning">
                {issue}
              </Notice>
            ))}
            {review.plan && (
              <>
                <Text style={typography.body}>
                  {review.plan.name} · {review.plan.formation.format}-a-side ·{" "}
                  {review.plan.formation.name}
                </Text>
                {review.plan.allocations.map((row) => (
                  <Text key={row.slotId} style={typography.body}>
                    {
                      review.plan!.formation.slots.find(
                        (slot) => slot.id === row.slotId,
                      )?.label
                    }{" "}
                    · {label(row.playerId)}
                  </Text>
                ))}
                <Text style={typography.body}>
                  Preferred spell{" "}
                  {review.plan.settings.payload.minimumStintMs / 60_000}min ·
                  batch {review.plan.settings.payload.batchLimit} · lead{" "}
                  {review.plan.settings.payload.scoreLeadThreshold} · return{" "}
                  {review.plan.settings.payload.returnToNormalEnabled
                    ? "Yes"
                    : "No"}{" "}
                  · half buffer{" "}
                  {review.plan.settings.softPreferences.halfBufferFraction *
                    100}
                  %
                </Text>
              </>
            )}
            <Notice>
              Only the proposed formation, allocations and settings are copied.
              Current squad selection, availability replies and attendance
              remain unchanged. Actual check-in, staging, policy confirmation
              and kickoff are separate.
            </Notice>
            {review.previewKey !== freshReview?.previewKey && (
              <Notice tone="warning">
                Preparation changed after this preview. Open a fresh preview
                before confirming.
              </Notice>
            )}
            <Button
              label="Confirm copy into this unplayed fixture"
              testID="confirm-apply-match-plan"
              disabled={
                busy ||
                !review.ready ||
                review.previewKey !== freshReview?.previewKey
              }
              onPress={() => {
                if (!review.plan) return;
                void onCommand({
                  type: "match_plan.applied",
                  planId: review.plan.id,
                  planVersion: review.plan.version,
                  fixtureId: fixture.id,
                  previewKey: review.previewKey,
                  confirm: true,
                }).then((saved) => {
                  if (saved) {
                    setReview(null);
                    setNotice(
                      "Plan copied as a preparation draft. Review it before staging any actual players.",
                    );
                  }
                });
              }}
            />
            <Button
              label="Cancel plan preview"
              variant="quiet"
              disabled={busy}
              onPress={() => setReview(null)}
            />
          </View>
        )}
        {fixture.matchPlanDraft && (
          <>
            <Text style={typography.label}>
              Applied draft · {fixture.matchPlanDraft.formation.name} v
              {fixture.matchPlanDraft.templateVersion}
            </Text>
            <Button
              label="Remove this fixture’s plan draft"
              variant="quiet"
              disabled={busy}
              onPress={() => {
                void onCommand({
                  type: "match_plan.cleared",
                  fixtureId: fixture.id,
                });
              }}
            />
          </>
        )}
      </View>
    </Card>
  );
}
