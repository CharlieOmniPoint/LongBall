import { formatUkDate, formatUkSeasonLabel } from '@longball/application/uk-display';
import { useState } from "react";
import { Switch, Text, View } from "react-native";
import type {
  SeasonRolloverCommand,
  seasonRolloverOptions,
} from "@longball/application/season-service";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, Pill } from "../ui";
import { typography } from "../ui/tokens";

export type ConnectedSeasonOptions = ReturnType<typeof seasonRolloverOptions>;
export function ConnectedSeasonRollover({
  options,
  disabled,
  onSave,
  onCreated,
}: {
  options: ConnectedSeasonOptions;
  disabled: boolean;
  onSave: (command: SeasonRolloverCommand) => Promise<boolean>;
  onCreated?: (seasonId: string) => void;
}) {
  const [managers, setManagers] = useState<string[]>([]);
  const [administrators, setAdministrators] = useState<string[]>([]);
  const [players, setPlayers] = useState<string[]>([]);
  const [copyPlayers, setCopyPlayers] = useState(true);
  const [renewalAcknowledged, setRenewalAcknowledged] = useState(false);
  const [review, setReview] = useState<SeasonRolloverCommand | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
  if (destination)
    return (
      <Card>
        <Pill>New season saved</Pill>
        <Text style={typography.section}>{formatUkSeasonLabel(options.nextSeason.label)}</Text>
        <Text style={typography.body}>
          The previous season’s records and match snapshots were preserved.
          Spectators receive no automatic new-season grant.
        </Text>
        {onCreated && (
          <Button
            label="Open the new authorised season"
            onPress={() => onCreated(destination)}
          />
        )}
      </Card>
    );
  if (review)
    return (
      <Card>
        <Text style={typography.section}>
          Review explicit season assignments
        </Text>
        <Text style={typography.body}>
          {formatUkSeasonLabel(options.nextSeason.label)} · {formatUkDate(options.nextSeason.startDate)} to{" "}
          {formatUkDate(options.nextSeason.endDate)}
        </Text>
        <Text style={typography.body}>
          Managers:{" "}
          {review.managerAccountIds
            .map(
              (id) =>
                options.managerCandidates.find(
                  (person) => person.accountId === id,
                )?.label ?? id,
            )
            .join(", ")}
        </Text>
        <Text style={typography.body}>
          Administrators:{" "}
          {review.administratorAccountIds
            .map(
              (id) =>
                options.managerCandidates.find(
                  (person) => person.accountId === id,
                )?.label ?? id,
            )
            .join(", ")}
        </Text>
        <Text style={typography.body}>
          {review.copyPlayers
            ? "Copy active player profiles and reusable formations."
            : "Start with no copied player profiles."}{" "}
          {review.playerAssignments.length} explicit existing player-account
          links.
        </Text>
        <Notice>
          Spectator access requires an individually issued new-season
          invitation. No fixture results, ballots, attendance or photos are
          carried into the new season.
        </Notice>
        <Button
          label="Create season with these explicit assignments"
          testID="season-rollover-confirm"
          disabled={disabled || !options.canRollover}
          onPress={() => {
            void onSave(review).then((saved) => {
              if (saved) {
                setDestination(review.idForSeason);
                onCreated?.(review.idForSeason);
              }
            });
          }}
        />
        <Button
          label="Edit season assignments"
          variant="secondary"
          disabled={disabled}
          onPress={() => setReview(null)}
        />
      </Card>
    );
  return (
    <View style={{ gap: 12 }} testID="connected-season-rollover">
      <Card>
        <Text style={typography.section}>Prepare the next season</Text>
        <Text style={typography.body}>
          From {options.sourceSeason.label} to {formatUkSeasonLabel(options.nextSeason.label)}
        </Text>
        <Text style={typography.muted}>
          {formatUkDate(options.nextSeason.startDate)} to {formatUkDate(options.nextSeason.endDate)} ·
          September–August
        </Text>
        {options.existingNextSeasonId ? (
          <Notice>
            The next season already exists. Select its authorised season scope
            above; rollover cannot create a second season for the same year.
          </Notice>
        ) : (
          !options.canRollover && (
            <Notice tone="warning">
              Creating season authority requires a current team administrator
              with recent stronger authentication. Sign in again or ask an
              existing authorised administrator.
            </Notice>
          )
        )}
        <Notice>
          Rollover creates separate new-season documents. Existing matches and
          historical records keep their original snapshots and audit history.
        </Notice>
      </Card>
      <Card>
        <Text style={typography.section}>
          Choose managers and administrators
        </Text>
        <Text style={typography.muted}>
          Select explicitly. The service enforces the team-wide limit of four
          distinct active manager accounts.
        </Text>
        {options.managerCandidates.map((person) => (
          <View key={person.accountId} style={{ gap: 8 }}>
            <Button
              label={`${person.label}${person.currentManager ? " · current manager" : ""}${managers.includes(person.accountId) ? " · selected manager" : ""}`}
              variant={
                managers.includes(person.accountId) ? "primary" : "secondary"
              }
              disabled={disabled || !options.canRollover}
              onPress={() =>
                setManagers((current) => toggle(current, person.accountId))
              }
            />
            {person.administrator && (
              <Button
                label={`${person.label}${administrators.includes(person.accountId) ? " · retained administrator" : " · retain administrator?"}`}
                variant={
                  administrators.includes(person.accountId)
                    ? "primary"
                    : "secondary"
                }
                disabled={disabled || !options.canRollover}
                onPress={() =>
                  setAdministrators((current) =>
                    toggle(current, person.accountId),
                  )
                }
              />
            )}
          </View>
        ))}
      </Card>
      <Card>
        <Text style={typography.section}>
          Player profiles and account links
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={[typography.body, { flex: 1 }]}>
            Copy active player profiles
          </Text>
          <Switch
            accessibilityLabel="Copy active player profiles to new season"
            value={copyPlayers}
            disabled={disabled || !options.canRollover}
            onValueChange={(value) => {
              setCopyPlayers(value);
              if (!value) setPlayers([]);
            }}
          />
        </View>
        <Text style={typography.muted}>
          Only verified existing source player-account links are offered. A new
          person requires the separate account activation route.
        </Text>
        {copyPlayers &&
          options.playerCandidates.map((person) => (
            <Button
              key={`${person.accountId}:${person.playerId}`}
              label={`${person.label}${players.includes(person.accountId) ? " · link selected" : ""}`}
              variant={
                players.includes(person.accountId) ? "primary" : "secondary"
              }
              disabled={disabled || !options.canRollover}
              onPress={() =>
                setPlayers((current) => toggle(current, person.accountId))
              }
            />
          ))}
      </Card>
      <Card>
        <Button
          label={
            renewalAcknowledged
              ? "Individual spectator renewal acknowledged"
              : "Acknowledge individual spectator renewal"
          }
          variant={renewalAcknowledged ? "primary" : "secondary"}
          disabled={disabled}
          onPress={() => setRenewalAcknowledged((value) => !value)}
        />
        <Button
          label="Review next season assignments"
          testID="season-rollover-review"
          disabled={
            disabled ||
            !options.canRollover ||
            managers.length < 1 ||
            managers.length > 4 ||
            administrators.length < 1 ||
            !renewalAcknowledged
          }
          onPress={() =>
            setReview({
              id: randomUUID(),
              type: "season.rolled_over",
              expectedPreparationRevision: options.revision,
              idForSeason: randomUUID(),
              startYear: options.nextSeason.startYear,
              copyPlayers,
              managerAccountIds: managers,
              administratorAccountIds: administrators,
              playerAssignments: copyPlayers
                ? options.playerCandidates
                    .filter((person) => players.includes(person.accountId))
                    .map((person) => ({
                      accountId: person.accountId,
                      playerId: person.playerId,
                    }))
                : [],
              confirmSpectatorRenewal: true,
            })
          }
        />
      </Card>
    </View>
  );
}
