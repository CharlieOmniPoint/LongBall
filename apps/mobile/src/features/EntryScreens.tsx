import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ReviewRole } from "@longball/application/review-entry";
import {
  Button,
  Card,
  colors,
  Icon,
  Notice,
  Pill,
  typography,
  type IconName,
} from "../ui";

export type { ReviewRole } from "@longball/application/review-entry";
interface EntryFeedback {
  loading?: boolean;
  error?: string | null;
  status?: string | null;
}
export interface WelcomeScreenProps extends EntryFeedback {
  onSignIn: () => void;
  onActivate: () => void;
  onReview?: () => void;
  onPrivacy?: () => void;
  onHelp?: () => void;
  /** Safe explanatory copy only; invitation credentials stay in the owning router. */
  invitationNotice?: string;
}
export interface ReviewAccountScreenProps extends EntryFeedback {
  onSelect: (role: ReviewRole) => void;
  onBack: () => void;
}
export const reviewAccounts: readonly {
  role: ReviewRole;
  title: string;
  description: string;
  action: string;
  icon: IconName;
}[] = [
  {
    role: "manager",
    title: "Manager",
    description: "Prepare the squad, record attendance and run the match.",
    action: "Explore manager view",
    icon: "users",
  },
  {
    role: "administrator",
    title: "Administrator",
    description: "Manage club details, staff access and season setup.",
    action: "Explore administrator view",
    icon: "settings",
  },
  {
    role: "player",
    title: "Player / household",
    description: "Reply to fixtures, choose preferences and follow the team.",
    action: "Explore player view",
    icon: "ball",
  },
  {
    role: "spectator",
    title: "Spectator",
    description: "Follow the match updates, awards and photos shared with you.",
    action: "Explore spectator view",
    icon: "home",
  },
];

/** Original LongBall branding, without implying a signed-in club or team. */
export function LongBallWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <View
      style={styles.wordmark}
      accessible
      accessibilityRole="header"
      accessibilityLabel="LongBall"
    >
      <Icon name="ball" size={compact ? 26 : 34} color={colors.brand} />
      <Text style={[styles.wordmarkText, compact && styles.compactWordmark]}>
        LongBall
      </Text>
    </View>
  );
}
function EntryStatus({ loading = false, error, status }: EntryFeedback) {
  if (!loading && !error && !status) return null;
  return (
    <View style={styles.feedback} accessibilityLiveRegion="polite">
      {loading && (
        <View
          style={styles.progress}
          accessibilityRole="progressbar"
          accessibilityLabel={status || "Opening this view"}
        >
          <ActivityIndicator color={colors.brand} />
          <Text style={[typography.body, styles.flex]}>
            {status || "Opening this view…"}
          </Text>
        </View>
      )}
      {!loading && status && <Notice>{status}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </View>
  );
}

/** Real account access and fictional review have separate, explicit entry actions. */
export function WelcomeScreen({
  onSignIn,
  onActivate,
  onReview,
  onPrivacy,
  onHelp,
  invitationNotice,
  loading = false,
  error,
  status,
}: WelcomeScreenProps) {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="welcome-screen"
      >
        <View style={styles.content}>
          <LongBallWordmark />
          <View style={styles.hero}>
            <View style={styles.rule} />
            <Text style={styles.headline} accessibilityRole="header">
              Your team. Ready for match day.
            </Text>
            <Text style={styles.introduction}>
              Plan the squad, keep match day moving and share the team’s season.
            </Text>
          </View>
          {invitationNotice && (
            <Notice icon="shield">{invitationNotice}</Notice>
          )}
          <EntryStatus loading={loading} error={error} status={status} />
          <Card>
            <Text style={typography.section} accessibilityRole="header">
              Your club account
            </Text>
            <Text style={typography.body}>
              Sign in to your club. Your access is assigned by the club after
              sign-in.
            </Text>
            <Button
              label="Sign in"
              icon="lock"
              testID="welcome-sign-in"
              disabled={loading}
              onPress={onSignIn}
            />
            <Button
              label="Activate account"
              variant="secondary"
              testID="welcome-activate"
              disabled={loading}
              onPress={onActivate}
            />
          </Card>
          {onReview && (
            <Card style={styles.reviewCard}>
              <Pill tone="muted">FICTIONAL REVIEW</Pill>
              <Text style={typography.section} accessibilityRole="header">
                Take a look around
              </Text>
              <Text style={typography.body}>
                Try LongBall with made-up players and matches. No club account
                is needed.
              </Text>
              <Button
                label="Explore fictional Roma U10"
                variant="secondary"
                icon="arrow"
                testID="welcome-review"
                disabled={loading}
                onPress={onReview}
              />
            </Card>
          )}
          {(onPrivacy || onHelp) && (
            <View style={styles.support}>
              {onPrivacy && (
                <Button
                  label="Privacy and data"
                  variant="quiet"
                  style={styles.supportButton}
                  testID="welcome-privacy"
                  onPress={onPrivacy}
                />
              )}
              {onHelp && (
                <Button
                  label="Help"
                  variant="quiet"
                  style={styles.supportButton}
                  testID="welcome-help"
                  onPress={onHelp}
                />
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** These are fictional personas, never a role-registration or real authentication control. */
export function ReviewAccountScreen({
  onSelect,
  onBack,
  loading = false,
  error,
  status,
}: ReviewAccountScreenProps) {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="review-account-screen"
      >
        <View style={styles.content}>
          <View style={styles.reviewHeader}>
            <LongBallWordmark compact />
            <Button
              label="Back"
              variant="quiet"
              icon="left"
              disabled={loading}
              testID="review-account-back"
              onPress={onBack}
            />
          </View>
          <View style={styles.accountIntroduction}>
            <Pill tone="muted">FICTIONAL ROMA U10</Pill>
            <Text style={styles.accountTitle} accessibilityRole="header">
              Choose a review account
            </Text>
            <Text style={typography.body}>
              Explore the app with made-up players and matches. These choices do
              not sign you in to a real club.
            </Text>
          </View>
          <EntryStatus loading={loading} error={error} status={status} />
          {reviewAccounts.map((account) => (
            <Card key={account.role}>
              <View style={styles.accountHeading}>
                <View style={styles.roleIcon}>
                  <Icon name={account.icon} color={colors.brand} size={24} />
                </View>
                <Text
                  style={[typography.section, styles.flex]}
                  accessibilityRole="header"
                >
                  {account.title}
                </Text>
              </View>
              <Text style={typography.body}>{account.description}</Text>
              <Button
                label={account.action}
                variant="secondary"
                testID={`review-entry-${account.role}`}
                disabled={loading}
                onPress={() => onSelect(account.role)}
              />
            </Card>
          ))}
          <Text style={[typography.muted, styles.reviewFootnote]}>
            For your own club, go back and sign in. Your club controls real
            account access.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24,
  },
  content: { width: "100%", maxWidth: 480, alignSelf: "center", gap: 20 },
  wordmark: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 1,
  },
  wordmarkText: {
    color: colors.ink,
    fontSize: 30,
    lineHeight: 38,
    fontWeight: "700",
    letterSpacing: -0.6,
    flexShrink: 1,
  },
  compactWordmark: { fontSize: 24, lineHeight: 30 },
  hero: { gap: 14, paddingTop: 8, paddingBottom: 4 },
  rule: {
    width: 48,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.brand,
  },
  headline: {
    color: colors.ink,
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  introduction: { color: colors.inkMuted, fontSize: 18, lineHeight: 27 },
  reviewCard: { borderColor: colors.brand },
  support: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  supportButton: { flexGrow: 1, flexBasis: 112 },
  feedback: { gap: 12 },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
  },
  flex: { flex: 1, minWidth: 0 },
  reviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  accountIntroduction: { gap: 12 },
  accountTitle: {
    color: colors.ink,
    fontSize: 28,
    lineHeight: 35,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  accountHeading: { flexDirection: "row", alignItems: "center", gap: 12 },
  roleIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E4F1E9",
  },
  reviewFootnote: { paddingHorizontal: 4 },
});
