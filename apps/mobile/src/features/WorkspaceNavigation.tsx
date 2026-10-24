import { useWorkspaceLayout } from '../ui/WorkspaceLayout';
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Role } from "@longball/application/access";
import { Icon, type IconName } from "../ui";
import { colors } from "../ui/tokens";
import { useRoleTheme } from '../ui/RoleTheme';

export type WorkspaceTab =
  | "overview"
  | "stats"
  | "feedback"
  | "formation"
  | "clubReports"
  | "opposition"
  | "documents"
  | "home"
  | "clubs"
  | "people"
  | "account"
  | "centre"
  | "schedule"
  | "team"
  | "settings"
  | "seasons"
  | "reports"
  | "community"
  | "invitations"
  | "privileges"
  | "controller"
  | "more";
type Item = { tab: WorkspaceTab; label: string; icon: IconName };
const primary: Record<Role, readonly Item[]> = {
  manager: [
    { tab: "home", label: "Home", icon: "home" },
    { tab: "schedule", label: "Schedule", icon: "calendar" },
    { tab: "team", label: "Team", icon: "users" },
    { tab: "stats", label: "Stats", icon: "chart" },
    { tab: "more", label: "More", icon: "more" },
  ],
  player: [
    { tab: "home", label: "Home", icon: "home" },
    { tab: "schedule", label: "Schedule", icon: "calendar" },
    { tab: "stats", label: "My Stats", icon: "chart" },
    { tab: "community", label: "Photos", icon: "photo" },
    { tab: "more", label: "More", icon: "more" },
  ],
  spectator: [
    { tab: "overview", label: "Home", icon: "home" },
    { tab: "centre", label: "Scores", icon: "ball" },
    { tab: "reports", label: "Results", icon: "chart" },
    { tab: "community", label: "Photos", icon: "photo" },
    { tab: "account", label: "Account", icon: "lock" },
  ],
  administrator: [
    { tab: "clubs", label: "Clubs", icon: "shield" },
    { tab: "team", label: "Teams", icon: "users" },
    { tab: "schedule", label: "Schedule", icon: "calendar" },
    { tab: "stats", label: "Stats", icon: "chart" },
    { tab: "more", label: "More", icon: "more" },
  ],
};

/** Current membership determines the navigation; server authorisation still gates each view. */
export function WorkspaceNavigation({
  role,
  active,
  disabled,
  onSelect,
}: {
  role: Role;
  active: WorkspaceTab;
  disabled: boolean;
  onSelect: (tab: WorkspaceTab) => void;
}) {
  const layout=useWorkspaceLayout();
  const theme=useRoleTheme();
  const rail=layout.rail&&(role==='manager'||role==='administrator');
  const items = primary[role];
  const selected = items.some((item) => item.tab === active) ? active : "more";
  return (
    <View
      style={[s.bar,rail&&{flexDirection:"column",gap:8,borderWidth:0}]}
      accessibilityRole="tablist"
      testID="workspace-primary-navigation"
    >
      {items.map((item) => (
        <Pressable
          key={item.tab}
          accessibilityRole="tab"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: selected === item.tab, disabled }}
          aria-selected={selected === item.tab}
          aria-disabled={disabled}
          testID={`workspace-tab-${item.tab}`}
          disabled={disabled}
          onPress={() => onSelect(item.tab)}
          style={({ pressed }) => [
            s.tab,
            rail&&{flex:0,flexDirection:"row",justifyContent:"flex-start",paddingHorizontal:12,gap:10,minHeight:52},
            selected === item.tab && {backgroundColor:theme.tint},
            disabled && s.disabled,
            pressed && s.pressed,
          ]}
        >
          <Icon
            name={item.icon}
            size={21}
            color={selected === item.tab ? theme.accent : colors.inkMuted}
          />
          <Text
            style={[s.label, selected === item.tab && {color:theme.accent}]}
          >
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 3,
    paddingVertical: 4,
  },
  tab: {
    minHeight: 56,
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    borderRadius: 10,
    paddingHorizontal: 1,
  },
  active: { backgroundColor: "#E9F3ED" },
  label: {
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
    fontWeight: "600",
    color: colors.inkMuted,
  },
  activeLabel: { color: colors.brand },
  disabled: { opacity: 0.5 },
  pressed: { backgroundColor: colors.bench },
});
