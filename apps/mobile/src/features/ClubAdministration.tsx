import { retainedActionFailureIsUnconfirmed } from "@longball/application/retained-action";
import { formatUkSeasonLabel } from "@longball/application/uk-display";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { Principal } from "@longball/application/access";
import {
  administrationLabel,
  type ClubAdministrationCommand,
  type ClubAdministrationDto,
  type ClubDirectoryTeam,
  type ClubReportDto,
  type ClubReportRow,
} from "@longball/application/club-administration";
import { accountChoiceLabel } from "../platform/account-choice-labels";
import { Button, Card, Notice, Pill, colors, typography } from "../ui";
import {
  AdministrationTeamDirectory,
  type AdministrationTeamOpenMode,
} from "./AdministrationTeamDirectory";

type AccessCommand = Extract<
  ClubAdministrationCommand,
  { type: "administrator.grant" | "administrator.revoke" }
>;

type ClubAdministrationProps = {
  section?: "all" | "teams" | "reports";
  principal: Principal;
  load: () => Promise<ClubAdministrationDto>;
  save: (command: ClubAdministrationCommand) => Promise<ClubAdministrationDto>;
  loadReport: (clubId: string) => Promise<ClubReportDto>;
  onChanged?: () => void | Promise<void>;
  onOpenTeam?: (
    team: ClubDirectoryTeam,
    mode: AdministrationTeamOpenMode,
  ) => void;
  canManageTeam?: (team: ClubDirectoryTeam) => boolean;
  onRetainedChange?: (retained: boolean) => void;
  initialClubId?: string;
  initialTeamId?: string;
};

export function ClubAdministration(props: ClubAdministrationProps) {
  return (
    <ScopedClubAdministration
      key={`${props.principal.accountId}:${JSON.stringify(props.principal.administration ?? null)}:${props.initialTeamId ?? ""}`}
      {...props}
    />
  );
}

function ScopedClubAdministration({
  principal,
  load,
  save,
  loadReport,
  onChanged,
  section = "all",
  onOpenTeam,
  canManageTeam,
  onRetainedChange,
  initialClubId,
  initialTeamId,
}: ClubAdministrationProps) {
  const [data, setData] = useState<ClubAdministrationDto | null>(null);
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const [clubId, setClubId] = useState("");
  const [clubName, setClubName] = useState(""),
    [teamName, setTeamName] = useState("");
  const [clubFormOpen, setClubFormOpen] = useState(false),
    [teamFormOpen, setTeamFormOpen] = useState(false),
    [accessOpen, setAccessOpen] = useState(false);
  const [ageGroup, setAgeGroup] = useState("U10"),
    [format, setFormat] = useState("7"),
    [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [acknowledgedTeamFields, setAcknowledgedTeamFields] = useState(() => ({
    ageGroup: "U10",
    format: "7",
    year: String(new Date().getUTCFullYear()),
  }));
  const [report, setReport] = useState<ClubReportDto | null>(null),
    [ageFilter, setAgeFilter] = useState("All"),
    [reportSearch, setReportSearch] = useState(""),
    [reportLimit, setReportLimit] = useState(20);
  const [sort, setSort] = useState<
    "ageGroup" | "name" | "completedGames" | "wins" | "goalsFor"
  >("ageGroup");
  const [target, setTarget] = useState(""),
    [accountSearch, setAccountSearch] = useState(""),
    [accountLimit, setAccountLimit] = useState(20);
  const [accessReview, setAccessReview] = useState<AccessCommand | null>(null);
  const [pending, setPending] = useState<ClubAdministrationCommand | null>(
      null,
    ),
    [lastCreatedTeam, setLastCreatedTeam] = useState<ClubDirectoryTeam | null>(
      null,
    );
  const writing = useRef(false),
    generation = useRef(0),
    reportGeneration = useRef(0),
    mounted = useRef(true);
  const binding = `${principal.accountId}:${JSON.stringify(principal.administration ?? null)}`;
  const currentBinding = useRef(binding);
  useLayoutEffect(() => {
    currentBinding.current = binding;
  });
  const invalidate = useCallback(() => {
    generation.current++;
    reportGeneration.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [invalidate]);
  const current = useCallback(
    (captured: string) =>
      mounted.current && currentBinding.current === captured,
    [],
  );
  const refresh = useCallback(async () => {
    const ticket = ++generation.current,
      captured = binding;
    setLoading(true);
    setError(null);
    try {
      const d = await load();
      if (!current(captured) || ticket !== generation.current) return;
      setData(d);
      const preferredClubId =
        d.teams.find((team) => team.id === initialTeamId)?.clubId ??
        initialClubId;
      setClubId((value) =>
        d.clubs.some((club) => club.id === value)
          ? value
          : (d.clubs.find((club) => club.id === preferredClubId)?.id ??
            d.clubs[0]?.id ??
            ""),
      );
    } catch (cause) {
      if (current(captured) && ticket === generation.current) {
        const status =
          cause && typeof cause === "object" && "status" in cause
            ? Number(cause.status)
            : 0;
        if ([401, 403, 404].includes(status)) {
          setData(null);
          setReport(null);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Club administration is unavailable.",
        );
      }
    } finally {
      if (current(captured) && ticket === generation.current) setLoading(false);
    }
  }, [load, binding, current, initialClubId, initialTeamId]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [refresh]);
  const selectClub = (id: string, confirmedChange = false) => {
    if (id === clubId) return;
    if (!confirmedChange && id !== clubId && hasLocalDraft) {
      setError("Save or discard your draft before changing clubs.");
      return;
    }
    reportGeneration.current++;
    setClubId(id);
    setReport(null);
    setAgeFilter("All");
    setReportSearch("");
    setReportLimit(20);
    setError(null);
    setMessage(null);
    setAccessReview(null);
    setLastCreatedTeam(null);
  };
  const readReport = useCallback(
    async (selectedClub: string) => {
      if (!selectedClub || writing.current) return;
      const ticket = ++reportGeneration.current,
        captured = binding;
      setReportLoading(true);
      setError(null);
      try {
        const value = await loadReport(selectedClub);
        if (value.kind !== "club-report" || value.club.id !== selectedClub)
          throw new Error(
            "The service returned a report for a different club. Refresh the selected club to try again.",
          );
        if (current(captured) && ticket === reportGeneration.current)
          setReport(value);
      } catch (cause) {
        if (current(captured) && ticket === reportGeneration.current) {
          const status =
            cause && typeof cause === "object" && "status" in cause
              ? Number(cause.status)
              : 0;
          if ([401, 403, 404].includes(status)) setReport(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "Club report is unavailable.",
          );
        }
      } finally {
        if (current(captured) && ticket === reportGeneration.current)
          setReportLoading(false);
      }
    },
    [loadReport, binding, current],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      if (section === "reports" && clubId) void readReport(clubId);
    }, 0);
    return () => clearTimeout(timer);
  }, [section, clubId, readReport]);
  const apply = async (command: ClubAdministrationCommand) => {
    if (
      writing.current ||
      (pending && JSON.stringify(pending) !== JSON.stringify(command))
    )
      return;
    writing.current = true;
    generation.current++;
    reportGeneration.current++;
    const captured = binding,
      oldTeamKeys = new Set(
        data?.teams.map((team) => `${team.id}:${team.seasonId}`),
      ),
      oldClubIds = new Set(data?.clubs.map((club) => club.id));
    setSaving(true);
    setError(null);
    setMessage(null);
    onRetainedChange?.(true);
    let accepted = false;
    try {
      const d = await save(command);
      accepted = true;
      if (!current(captured)) return;
      setData(d);
      setPending(null);
      setAccessReview(null);
      setReport(null);
      if (command.type === "club.create") {
        const created = d.clubs.find((club) => !oldClubIds.has(club.id));
        if (created) selectClub(created.id, true);
        setClubName((value) => (value.trim() === command.name ? "" : value));
        setClubFormOpen(false);
        setMessage("Club created. Add its first team below.");
      } else if (command.type === "team.create") {
        const created = d.teams.find(
          (team) =>
            !oldTeamKeys.has(`${team.id}:${team.seasonId}`) &&
            team.clubId === command.clubId &&
            team.name === command.name,
        );
        setClubId(command.clubId);
        setLastCreatedTeam(created ?? null);
        setTeamName((value) => (value.trim() === command.name ? "" : value));
        setAcknowledgedTeamFields({
          ageGroup: command.ageGroup,
          format: String(command.format),
          year: String(command.seasonStartYear),
        });
        setTeamFormOpen(false);
        setMessage("Team created. Open it below to start setting up.");
      } else {
        setTarget((value) => (value === command.accountId ? "" : value));
        setMessage("Administrator access updated.");
      }
      try {
        await onChanged?.();
      } catch {
        if (current(captured))
          setError(
            "The change was saved, but the workspace could not refresh. Refresh clubs before opening a new team.",
          );
      }
    } catch (cause) {
      if (current(captured)) {
        if (accepted) {
          setPending(null);
          setAccessReview(null);
          if (command.type === "club.create")
            setClubName((value) =>
              value.trim() === command.name ? "" : value,
            );
          else if (command.type === "team.create") {
            setTeamName((value) =>
              value.trim() === command.name ? "" : value,
            );
            setAcknowledgedTeamFields({
              ageGroup: command.ageGroup,
              format: String(command.format),
              year: String(command.seasonStartYear),
            });
          } else
            setTarget((value) => (value === command.accountId ? "" : value));
          setError(
            "The change was saved, but its view could not be updated. Refresh clubs before making another change.",
          );
        } else if (
          !retainedActionFailureIsUnconfirmed(cause, pending !== null)
        ) {
          setPending(null);
        } else
          setPending(
            JSON.parse(JSON.stringify(command)) as ClubAdministrationCommand,
          );
        if (!accepted)
          setError(
            cause instanceof Error
              ? cause.message
              : "The change could not be confirmed.",
          );
      }
    } finally {
      writing.current = false;
      if (current(captured)) setSaving(false);
    }
  };
  const hasLocalDraft = Boolean(
    clubName.trim() ||
      teamName.trim() ||
      accessReview ||
      target ||
      ageGroup !== acknowledgedTeamFields.ageGroup ||
      format !== acknowledgedTeamFields.format ||
      year !== acknowledgedTeamFields.year,
  );
  const retained = hasLocalDraft || pending !== null || saving;
  useLayoutEffect(() => {
    onRetainedChange?.(retained);
  }, [onRetainedChange, retained]);
  const discardLocalDrafts = () => {
    if (writing.current || pending) return;
    setClubName("");
    setTeamName("");
    setAgeGroup(acknowledgedTeamFields.ageGroup);
    setFormat(acknowledgedTeamFields.format);
    setYear(acknowledgedTeamFields.year);
    setTarget("");
    setAccessReview(null);
    setMessage(null);
    setError(null);
  };
  const busy = loading || saving || reportLoading,
    locked = busy || pending !== null;
  const label = administrationLabel(principal),
    superAdmin = data?.administration.level === "super";
  const selectedClub = data?.clubs.find((club) => club.id === clubId);
  const filteredCandidates = (data?.candidates ?? []).filter((candidate) =>
    `${candidate.label} ${candidate.accountId}`
      .toLocaleLowerCase("en-GB")
      .includes(accountSearch.trim().toLocaleLowerCase("en-GB")),
  );
  const administratorChoices = [
    ...(data?.candidates ?? []),
    ...(data?.administrators ?? [])
      .filter(
        (person) =>
          !data?.candidates.some(
            (candidate) => candidate.accountId === person.accountId,
          ),
      )
      .map((person) => ({
        accountId: person.accountId,
        label: "Unavailable administrator",
      })),
  ];
  const targetLabel = (accountId: string) => {
    const account = administratorChoices.find(
      (candidate) => candidate.accountId === accountId,
    );
    if (!account) return "Administrator";
    const label = accountChoiceLabel(account, administratorChoices);
    return account.label === "Unavailable administrator" &&
      label === account.label
      ? `${label} · …${accountId.slice(-6)}`
      : label;
  };
  const reports = useMemo(
    () =>
      [...(report?.teams ?? [])]
        .filter(
          (team) =>
            (ageFilter === "All" || team.ageGroup === ageFilter) &&
            `${team.name} ${team.ageGroup} ${team.seasonLabel}`
              .toLocaleLowerCase("en-GB")
              .includes(reportSearch.trim().toLocaleLowerCase("en-GB")),
        )
        .sort((a, b) =>
          sort === "ageGroup"
            ? Number(a.ageGroup.slice(1)) - Number(b.ageGroup.slice(1)) ||
              a.name.localeCompare(b.name)
            : typeof a[sort] === "number"
              ? Number(b[sort]) - Number(a[sort]) ||
                a.name.localeCompare(b.name)
              : String(a[sort]).localeCompare(String(b[sort])),
        ),
    [report, ageFilter, reportSearch, sort],
  );
  const input = (
    label: string,
    value: string,
    change: (value: string) => void,
    numeric = false,
    maxLength = 100,
  ) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      value={value}
      onChangeText={change}
      editable={!locked}
      maxLength={maxLength}
      keyboardType={numeric ? "number-pad" : "default"}
      style={styles.input}
    />
  );
  const accessDescription = (command: AccessCommand) =>
    `${command.type === "administrator.grant" ? "Give" : "Remove"} ${command.level === "super" ? "Super Admin access across LongBall" : `Club Admin access to ${data?.clubs.find((club) => club.id === command.clubId)?.name ?? "the selected club"}`} ${command.type === "administrator.grant" ? "for" : "from"} ${targetLabel(command.accountId)}.`;
  return (
    <View style={{ gap: 16 }} testID="club-administration">
      <View style={styles.row}>
        <Text accessibilityRole="header" style={typography.section}>
          {section === "reports"
            ? "Club reports"
            : section === "teams"
              ? "Your teams"
              : label}
        </Text>
        <Button
          compact
          variant="quiet"
          label="Refresh clubs"
          onPress={() => void refresh()}
          disabled={locked}
        />
      </View>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {hasLocalDraft && !pending && !saving && (
        <View style={styles.row} testID="admin-unsaved-draft">
          <Text style={typography.muted}>
            Unsaved club, team or administrator changes are kept here until you
            save or discard them.
          </Text>
          <Button
            compact
            label="Discard administration drafts"
            testID="admin-discard-drafts"
            variant="quiet"
            onPress={discardLocalDrafts}
          />
        </View>
      )}
      {pending && (
        <Card testID="administration-pending">
          <Notice tone="warning">
            The service has not confirmed this change. The original request is
            kept; retry it before starting another change.
          </Notice>
          <Text style={typography.body}>
            {pending.type === "team.create"
              ? `Create ${pending.name} ${pending.ageGroup}`
              : pending.type === "club.create"
                ? `Create ${pending.name}`
                : accessDescription(pending)}
          </Text>
          <Button
            label={
              saving ? "Confirming saved request…" : "Retry the same change"
            }
            testID="admin-retry-change"
            disabled={busy}
            onPress={() => void apply(pending)}
          />
        </Card>
      )}
      {!data ? (
        <Text style={typography.body}>
          {loading
            ? "Loading clubs…"
            : "Club administration is unavailable. Refresh to try again."}
        </Text>
      ) : (
        <>
          {superAdmin && section === "all" && (
            <Card>
              <Button
                label={clubFormOpen ? "Hide club form" : "Add club"}
                compact
                variant="secondary"
                testID="admin-club-form-toggle"
                disabled={locked}
                accessibilityState={{ expanded: clubFormOpen }}
                onPress={() => setClubFormOpen((value) => !value)}
              />
              {clubFormOpen && (
                <>
                  <Text style={typography.section}>Create club</Text>
                  {input("New club name", clubName, setClubName)}
                  <Button
                    label="Create club"
                    testID="admin-create-club"
                    disabled={
                      locked || !clubName.trim() || clubName.trim().length > 100
                    }
                    onPress={() =>
                      void apply({ type: "club.create", name: clubName.trim() })
                    }
                  />
                </>
              )}
            </Card>
          )}
          {section !== "reports" && (
            <AdministrationTeamDirectory
              clubs={data.clubs}
              teams={data.teams}
              clubId={clubId}
              disabled={locked}
              onSelectClub={selectClub}
              onOpenTeam={onOpenTeam}
              canManageTeam={canManageTeam}
              createTeamOpen={teamFormOpen}
              onCreateTeam={() => setTeamFormOpen((value) => !value)}
            />
          )}
          {section !== "reports" && teamFormOpen && clubId && (
            <Card testID="admin-team-form">
              <Text style={typography.section}>
                Add team to {selectedClub?.name ?? "this club"}
              </Text>
              {input("New team name", teamName, setTeamName)}
              <View style={styles.row}>
                <View style={styles.cell}>
                  <Text style={typography.muted}>Age group U5–U21</Text>
                  {input("New team age group", ageGroup, (value) =>
                    setAgeGroup(value.toUpperCase().replace(/\s/g, "")),
                  )}
                </View>
                <View style={styles.cell}>
                  <Text style={typography.muted}>Players a side: 5–11</Text>
                  {input("New team format", format, setFormat, true)}
                </View>
                <View style={styles.cell}>
                  <Text style={typography.muted}>Season start year</Text>
                  {input("New team season start year", year, setYear, true)}
                </View>
              </View>
              {!/^U(?:[5-9]|1[0-9]|2[01])$/.test(ageGroup) && (
                <Text style={typography.muted}>
                  Use an age group from U5 to U21.
                </Text>
              )}
              {!/^([5-9]|1[01])$/.test(format) && (
                <Text style={typography.muted}>
                  Choose 5 to 11 players a side, including the goalkeeper.
                </Text>
              )}
              {!/^(?:20\d{2}|2100)$/.test(year) && (
                <Text style={typography.muted}>
                  Enter a season start year from 2000 to 2100.
                </Text>
              )}
              <Button
                label="Create team"
                testID="admin-create-team"
                disabled={
                  locked ||
                  !teamName.trim() ||
                  teamName.trim().length > 100 ||
                  !/^U(?:[5-9]|1[0-9]|2[01])$/.test(ageGroup) ||
                  !/^([5-9]|1[01])$/.test(format) ||
                  !/^(?:20\d{2}|2100)$/.test(year)
                }
                onPress={() =>
                  void apply({
                    type: "team.create",
                    clubId,
                    name: teamName.trim(),
                    ageGroup,
                    format: Number(format),
                    seasonStartYear: Number(year),
                  })
                }
              />
            </Card>
          )}
          {lastCreatedTeam && onOpenTeam && (
            <Card testID="admin-created-team">
              <Text style={typography.label}>
                {lastCreatedTeam.name} · {lastCreatedTeam.ageGroup} ·{" "}
                {formatUkSeasonLabel(lastCreatedTeam.seasonLabel)}
              </Text>
              <View style={styles.row}>
                <Button
                  compact
                  label="Open new team"
                  variant="secondary"
                  disabled={locked}
                  onPress={() => onOpenTeam(lastCreatedTeam, "overview")}
                />
                {canManageTeam?.(lastCreatedTeam) && (
                  <Button
                    compact
                    label="Manage new team"
                    disabled={locked}
                    onPress={() => onOpenTeam(lastCreatedTeam, "manage")}
                  />
                )}
              </View>
            </Card>
          )}
          {clubId && section !== "teams" && (
            <Card testID="admin-club-performance">
              <Text style={typography.section}>Club performance</Text>
              {section === "reports" && (
                <View style={styles.wrap}>
                  {data.clubs.map((club) => (
                    <Button
                      key={club.id}
                      compact
                      label={club.name}
                      variant={club.id === clubId ? "primary" : "secondary"}
                      accessibilityState={{ selected: club.id === clubId }}
                      disabled={locked}
                      onPress={() => selectClub(club.id)}
                    />
                  ))}
                </View>
              )}
              <Button
                label={
                  report ? "Refresh club performance" : "Load club performance"
                }
                testID="admin-club-report"
                disabled={locked}
                onPress={() => void readReport(clubId)}
              />
              {reportLoading && (
                <Text style={typography.muted}>Loading club performance…</Text>
              )}
              {report && (
                <>
                  <Text style={typography.body}>
                    {report.club.name} · recorded completed games
                  </Text>
                  <TextInput
                    accessibilityLabel="Search club report teams"
                    placeholder="Find a team"
                    value={reportSearch}
                    editable={!locked}
                    onChangeText={(value) => {
                      setReportSearch(value);
                      setReportLimit(20);
                    }}
                    style={styles.input}
                  />
                  <View style={styles.wrap}>
                    {[
                      "All",
                      ...Array.from(
                        new Set(report.teams.map((team) => team.ageGroup)),
                      ).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
                    ].map((age) => (
                      <Button
                        key={age}
                        compact
                        label={age}
                        testID={`admin-report-age-${age}`}
                        accessibilityLabel={
                          age === "All"
                            ? "All report age groups"
                            : `Report age group ${age}`
                        }
                        variant={ageFilter === age ? "primary" : "secondary"}
                        accessibilityState={{ selected: ageFilter === age }}
                        disabled={locked}
                        onPress={() => {
                          setAgeFilter(age);
                          setReportLimit(20);
                        }}
                      />
                    ))}
                  </View>
                  <Text style={typography.label}>Sort by</Text>
                  <View style={styles.wrap}>
                    {(
                      [
                        "ageGroup",
                        "name",
                        "completedGames",
                        "wins",
                        "goalsFor",
                      ] as const
                    ).map((key) => (
                      <Button
                        key={key}
                        compact
                        label={
                          {
                            ageGroup: "Age group",
                            name: "Team",
                            completedGames: "Games",
                            wins: "Wins",
                            goalsFor: "Goals",
                          }[key]
                        }
                        variant={sort === key ? "primary" : "secondary"}
                        accessibilityState={{ selected: sort === key }}
                        disabled={locked}
                        onPress={() => {
                          setSort(key);
                          setReportLimit(20);
                        }}
                      />
                    ))}
                  </View>
                  <Text style={typography.muted}>
                    {reports.length} matching team-season
                    {reports.length === 1 ? "" : "s"}
                  </Text>
                  {reports.slice(0, reportLimit).map((team) => (
                    <ClubReport
                      key={`${team.id}:${team.seasonId}`}
                      row={team}
                    />
                  ))}
                  {reports.length > reportLimit && (
                    <Button
                      compact
                      variant="secondary"
                      label="Show more report teams"
                      onPress={() => setReportLimit((value) => value + 20)}
                      disabled={locked}
                    />
                  )}{" "}
                  {!reports.length && (
                    <Text style={typography.body}>
                      No teams match these filters. Choose All ages or clear the
                      search.
                    </Text>
                  )}
                  <Text style={typography.muted}>
                    Totals use recorded results. Games without a recorded score
                    are excluded from W/D/L and goal totals.
                  </Text>
                </>
              )}
            </Card>
          )}
          {superAdmin && section === "all" && (
            <Card>
              <Button
                label={
                  accessOpen
                    ? "Hide administrator access"
                    : "Administrator access"
                }
                compact
                variant="secondary"
                testID="admin-access-toggle"
                accessibilityState={{ expanded: accessOpen }}
                disabled={locked}
                onPress={() => setAccessOpen((value) => !value)}
              />
              {accessOpen && (
                <>
                  <Text style={typography.body}>
                    Choose an existing verified adult. Club Admins manage their
                    club; Super Admins administer LongBall.
                  </Text>
                  <TextInput
                    accessibilityLabel="Search administrator accounts"
                    placeholder="Find an adult account"
                    value={accountSearch}
                    editable={!locked}
                    onChangeText={(value) => {
                      setAccountSearch(value);
                      setAccountLimit(20);
                    }}
                    style={styles.input}
                  />
                  <View style={styles.wrap}>
                    {filteredCandidates
                      .slice(0, accountLimit)
                      .map((candidate) => (
                        <Button
                          key={candidate.accountId}
                          compact
                          label={accountChoiceLabel(candidate, data.candidates)}
                          variant={
                            target === candidate.accountId
                              ? "primary"
                              : "secondary"
                          }
                          accessibilityState={{
                            selected: target === candidate.accountId,
                          }}
                          disabled={locked}
                          onPress={() => {
                            setTarget(candidate.accountId);
                            setAccessReview(null);
                          }}
                        />
                      ))}
                  </View>
                  {filteredCandidates.length > accountLimit && (
                    <Button
                      compact
                      variant="quiet"
                      label="Show more adult accounts"
                      disabled={locked}
                      onPress={() => setAccountLimit((value) => value + 20)}
                    />
                  )}{" "}
                  {!filteredCandidates.length && (
                    <Text style={typography.muted}>
                      No verified adult accounts match this search.
                    </Text>
                  )}
                  {target && (
                    <Text style={typography.label}>
                      Selected: {targetLabel(target)}
                    </Text>
                  )}
                  <View style={styles.wrap}>
                    <Button
                      compact
                      label="Grant Club Admin"
                      disabled={locked || !target || !clubId}
                      onPress={() =>
                        setAccessReview({
                          type: "administrator.grant",
                          accountId: target,
                          level: "club",
                          clubId,
                        })
                      }
                    />
                    <Button
                      compact
                      label="Grant Super Admin"
                      variant="secondary"
                      disabled={locked || !target}
                      onPress={() =>
                        setAccessReview({
                          type: "administrator.grant",
                          accountId: target,
                          level: "super",
                          clubId: null,
                        })
                      }
                    />
                  </View>
                  {data.administrators
                    .filter((person) =>
                      `${targetLabel(person.accountId)} ${person.accountId}`
                        .toLocaleLowerCase("en-GB")
                        .includes(
                          accountSearch.trim().toLocaleLowerCase("en-GB"),
                        ),
                    )
                    .map((person) => (
                      <View
                        key={`${person.accountId}:${person.clubId ?? "*"}`}
                        style={styles.team}
                      >
                        <Text style={typography.body}>
                          {targetLabel(person.accountId)} ·{" "}
                          {person.level === "super"
                            ? "Super Admin"
                            : `Club Admin · ${data.clubs.find((club) => club.id === person.clubId)?.name ?? "Club"}`}
                        </Text>
                        <Button
                          compact
                          variant="danger"
                          label="Revoke access"
                          accessibilityLabel={`Review revoking ${targetLabel(person.accountId)} ${person.level === "super" ? "Super Admin" : "Club Admin"} access`}
                          disabled={
                            locked || person.accountId === principal.accountId
                          }
                          onPress={() =>
                            setAccessReview({
                              type: "administrator.revoke",
                              accountId: person.accountId,
                              level: person.level,
                              clubId: person.clubId,
                            })
                          }
                        />
                      </View>
                    ))}
                </>
              )}
            </Card>
          )}
          {accessReview && (
            <Card testID="admin-access-review">
              <Text style={typography.section}>
                Review administrator access
              </Text>
              <Text style={typography.body}>
                {accessDescription(accessReview)}
              </Text>
              <Text selectable style={typography.muted}>
                Account reference: {accessReview.accountId}
              </Text>
              <Notice
                tone={
                  accessReview.type === "administrator.revoke"
                    ? "warning"
                    : "info"
                }
              >
                {accessReview.level === "super"
                  ? "Super Admin access covers every club in LongBall. "
                  : "This change applies only to the named club. "}
                The service checks current authority and recent stronger sign-in
                again when you confirm.
              </Notice>
              <View style={styles.row}>
                <Button
                  label="Confirm administrator access change"
                  testID="admin-access-confirm"
                  variant={
                    accessReview.type === "administrator.revoke"
                      ? "danger"
                      : "primary"
                  }
                  disabled={locked}
                  onPress={() => void apply(accessReview)}
                />
                <Button
                  label="Cancel access review"
                  variant="secondary"
                  disabled={locked}
                  onPress={() => setAccessReview(null)}
                />
              </View>
            </Card>
          )}
        </>
      )}
    </View>
  );
}
function ClubReport({ row }: { row: ClubReportRow }) {
  return (
    <View
      style={styles.team}
      testID={`admin-report-team-${row.id}-${row.seasonId}`}
    >
      <Text style={typography.label}>
        {row.name} · {row.ageGroup} · {formatUkSeasonLabel(row.seasonLabel)}
      </Text>
      <View style={styles.wrap}>
        <Pill tone="muted">{row.players} players</Pill>
        <Pill tone="muted">{row.completedGames} games</Pill>
        <Pill tone="muted">
          {row.wins}W {row.draws}D {row.losses}L
        </Pill>
        <Pill tone="muted">
          GF {row.goalsFor} · GA {row.goalsAgainst}
        </Pill>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  input: {
    ...typography.body,
    borderWidth: 1,
    borderColor: colors.controlBorder,
    borderRadius: 8,
    padding: 12,
    minHeight: 48,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cell: { flexGrow: 1, flexBasis: 95, gap: 4 },
  team: {
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.controlBorder,
  },
});
