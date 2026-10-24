import { formatUkSeasonLabel } from '@longball/application/uk-display';
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { Principal } from "@longball/application/access";
import {
  administrationLabel,
  type ClubAdministrationCommand,
  type ClubAdministrationDto,
  type ClubReportDto,
  type ClubReportRow,
} from "@longball/application/club-administration";
import { Button, Card, Notice, Pill, colors, typography } from "../ui";

export function ClubAdministration({
  principal,
  load,
  save,
  loadReport,
  onChanged,
  section = "all",
}: {
  section?: "all" | "reports";
  principal: Principal;
  load: () => Promise<ClubAdministrationDto>;
  save: (command: ClubAdministrationCommand) => Promise<ClubAdministrationDto>;
  loadReport: (clubId: string) => Promise<ClubReportDto>;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<ClubAdministrationDto | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const [clubId, setClubId] = useState(""),
    [clubName, setClubName] = useState(""),
    [teamName, setTeamName] = useState(""),
    [ageGroup, setAgeGroup] = useState("U10"),
    [format, setFormat] = useState("7"),
    [year, setYear] = useState(String(new Date().getUTCFullYear())),
    [filter, setFilter] = useState(""),
    [report, setReport] = useState<ClubReportDto | null>(null),
    [ageFilter, setAgeFilter] = useState("All"),
    [sort, setSort] = useState<
      "ageGroup" | "name" | "completedGames" | "wins" | "goalsFor"
    >("ageGroup");
  const [target, setTarget] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await load();
      setData(d);
      setClubId((c) =>
        d.clubs.some((x) => x.id === c) ? c : (d.clubs[0]?.id ?? ""),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Club administration is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  const apply = async (command: ClubAdministrationCommand) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const d = await save(command);
      setData(d);
      setMessage(
        command.type === "club.create"
          ? "Club created."
          : command.type === "team.create"
            ? "Team created. Use the Club and team selector to open it."
            : "Administrator access updated.",
      );
      setClubId((c) =>
        d.clubs.some((x) => x.id === c) ? c : (d.clubs[0]?.id ?? ""),
      );
      setReport(null);
      onChanged?.();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const teams = (data?.teams ?? []).filter(
    (t) =>
      (!clubId || t.clubId === clubId) &&
      `${t.name} ${t.ageGroup}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase()),
  );
  const reports = useMemo(
    () =>
      [...(report?.teams ?? [])]
        .filter((t) => ageFilter === "All" || t.ageGroup === ageFilter)
        .sort((a, b) =>
          sort === "ageGroup"
            ? Number(a.ageGroup.slice(1)) - Number(b.ageGroup.slice(1)) ||
              a.name.localeCompare(b.name)
            : typeof a[sort] === "number"
              ? Number(b[sort]) - Number(a[sort])
              : String(a[sort]).localeCompare(String(b[sort])),
        ),
    [report, ageFilter, sort],
  );
  const label = administrationLabel(principal),
    superAdmin = data?.administration.level === "super";
  return (
    <View style={{ gap: 16 }} testID="club-administration">
      <View style={styles.row}>
        <Text accessibilityRole="header" style={typography.section}>
          {label}
        </Text>
        <Button
          compact
          variant="quiet"
          label="Refresh clubs"
          onPress={() => void refresh()}
          disabled={busy}
        />
      </View>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {!data ? (
        <Text style={typography.body}>
          {busy ? "Loading clubs…" : "Club administration is unavailable."}
        </Text>
      ) : (
        <>
          {superAdmin && section === "all" && (
            <Card>
              <Text style={typography.section}>Create club</Text>
              <TextInput
                accessibilityLabel="New club name"
                placeholder="Club name"
                value={clubName}
                onChangeText={setClubName}
                maxLength={100}
                style={styles.input}
              />
              <Button
                label="Create club"
                testID="admin-create-club"
                disabled={busy || !clubName.trim()}
                onPress={() =>
                  void apply({ type: "club.create", name: clubName.trim() })
                }
              />
            </Card>
          )}
          <Card>
            <Text style={typography.section}>
              {section === "reports" ? "Choose a club" : "Clubs and teams"}
            </Text>
            <View style={styles.wrap}>
              {data.clubs.map((c) => (
                <Button
                  key={c.id}
                  compact
                  variant={clubId === c.id ? "primary" : "secondary"}
                  label={c.name}
                  onPress={() => {
                    setClubId(c.id);
                    setReport(null);
                  }}
                  disabled={busy}
                />
              ))}
            </View>
            {clubId && section === "all" && (
              <>
                <TextInput
                  accessibilityLabel="Search club teams"
                  placeholder="Find a team or age group"
                  value={filter}
                  onChangeText={setFilter}
                  style={styles.input}
                />
                <Text style={typography.body}>
                  {teams.length} team-season{teams.length === 1 ? "" : "s"}
                </Text>
                {teams.map((t) => (
                  <View key={`${t.id}:${t.seasonId}`} style={styles.team}>
                    <Text style={typography.label}>
                      {t.name} · {t.ageGroup}
                    </Text>
                    <Text style={typography.muted}>
                      {formatUkSeasonLabel(t.seasonLabel)}
                      {t.leagueName ? ` · ${t.leagueName}` : ""}
                    </Text>
                  </View>
                ))}
                <Text style={typography.label}>Add team to this club</Text>
                <TextInput
                  accessibilityLabel="New team name"
                  placeholder="Team name, e.g. Roma Lions"
                  value={teamName}
                  maxLength={100}
                  onChangeText={setTeamName}
                  style={styles.input}
                />
                <View style={styles.row}>
                  <View style={styles.cell}>
                    <Text style={typography.muted}>Age group U5–U21</Text>
                    <TextInput
                      accessibilityLabel="New team age group"
                      value={ageGroup}
                      onChangeText={(v) => setAgeGroup(v.toUpperCase())}
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.cell}>
                    <Text style={typography.muted}>Players a side</Text>
                    <TextInput
                      accessibilityLabel="New team format"
                      value={format}
                      onChangeText={setFormat}
                      keyboardType="number-pad"
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.cell}>
                    <Text style={typography.muted}>Season start year</Text>
                    <TextInput
                      accessibilityLabel="New team season start year"
                      value={year}
                      onChangeText={setYear}
                      keyboardType="number-pad"
                      style={styles.input}
                    />
                  </View>
                </View>
                <Button
                  label="Create team"
                  testID="admin-create-team"
                  disabled={
                    busy ||
                    !teamName.trim() ||
                    !/^U(?:[5-9]|1[0-9]|2[01])$/.test(ageGroup) ||
                    !/^([5-9]|1[01])$/.test(format) ||
                    !/^20\d{2}$/.test(year)
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
              </>
            )}
          </Card>
          {clubId && (
            <Card>
              <Text style={typography.section}>Club reports</Text>
              <Button
                label="Load club performance"
                testID="admin-club-report"
                disabled={busy}
                onPress={() => {
                  setBusy(true);
                  setError(null);
                  void loadReport(clubId)
                    .then(setReport)
                    .catch((e) =>
                      setError(
                        e instanceof Error
                          ? e.message
                          : "Club report is unavailable.",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              />
              {report && (
                <>
                  <Text style={typography.body}>
                    {report.club.name} · recorded completed games
                  </Text>
                  <View style={styles.wrap}>
                    {[
                      "All",
                      ...Array.from(
                        new Set(report.teams.map((t) => t.ageGroup)),
                      ).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
                    ].map((a) => (
                      <Button
                        compact
                        key={a}
                        label={a}
                        variant={ageFilter === a ? "primary" : "secondary"}
                        onPress={() => setAgeFilter(a)}
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
                    ).map((k) => (
                      <Button
                        compact
                        key={k}
                        label={
                          {
                            ageGroup: "Age group",
                            name: "Team",
                            completedGames: "Games",
                            wins: "Wins",
                            goalsFor: "Goals",
                          }[k]
                        }
                        variant={sort === k ? "primary" : "secondary"}
                        onPress={() => setSort(k)}
                      />
                    ))}
                  </View>
                  {reports.map((t) => (
                    <ClubReport key={`${t.id}:${t.seasonId}`} row={t} />
                  ))}
                  {!reports.length && (
                    <Text style={typography.body}>
                      No teams match this filter.
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
              <Text style={typography.section}>Administrator access</Text>
              <Text style={typography.body}>
                Choose an existing verified adult account. Club Admins inherit
                team management for their club; Super Admins operate across the
                application.
              </Text>
              <View style={styles.wrap}>
                {data.candidates.map((c) => (
                  <Button
                    compact
                    key={c.accountId}
                    label={c.label}
                    variant={target === c.accountId ? "primary" : "secondary"}
                    onPress={() => setTarget(c.accountId)}
                    disabled={busy}
                  />
                ))}
              </View>
              <View style={styles.wrap}>
                <Button
                  compact
                  label="Grant Club Admin"
                  disabled={busy || !target || !clubId}
                  onPress={() =>
                    void apply({
                      type: "administrator.grant",
                      accountId: target,
                      level: "club",
                      clubId,
                    })
                  }
                />
                <Button
                  compact
                  variant="secondary"
                  label="Grant Super Admin"
                  disabled={busy || !target}
                  onPress={() =>
                    void apply({
                      type: "administrator.grant",
                      accountId: target,
                      level: "super",
                      clubId: null,
                    })
                  }
                />
              </View>
              {data.administrators.map((a) => (
                <View
                  key={`${a.accountId}:${a.clubId ?? "*"}`}
                  style={styles.team}
                >
                  <Text style={typography.body}>
                    {data.candidates.find((c) => c.accountId === a.accountId)
                      ?.label ?? "Administrator"}{" "}
                    ·{" "}
                    {a.level === "super"
                      ? "Super Admin"
                      : `Club Admin · ${data.clubs.find((c) => c.id === a.clubId)?.name ?? "Club"}`}
                  </Text>
                  <Button
                    compact
                    variant="danger"
                    label="Revoke access"
                    disabled={busy || a.accountId === principal.accountId}
                    onPress={() =>
                      void apply({
                        type: "administrator.revoke",
                        accountId: a.accountId,
                        level: a.level,
                        clubId: a.clubId,
                      })
                    }
                  />
                </View>
              ))}
            </Card>
          )}
        </>
      )}
    </View>
  );
}
function ClubReport({ row }: { row: ClubReportRow }) {
  return (
    <View style={styles.team}>
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
