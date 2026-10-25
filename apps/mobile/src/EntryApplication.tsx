import { formatUkDateTime } from '@longball/application/uk-display';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  parseLongBallDestination,
  type LongBallDestination,
  type SpectatorInvitationDestination,
} from "@longball/application/deep-links";
import {
  discoverFictionalReview,
  REVIEW_IDENTITIES,
  type ReviewRole,
} from "@longball/application/review-entry";
import { ConnectedApplication } from "./ConnectedApplication";
import { FictionalReviewWorkspace } from "./features/FictionalReviewWorkspace";
import { ReviewAccountScreen, WelcomeScreen } from "./features/EntryScreens";
import { DemoLoginApplication } from "./features/DemoLoginApplication";
import { Button, Card, colors, Notice, Pill, typography } from "./ui";

export interface LocalReviewEntryProps {
  initialRole: "manager" | "player" | "spectator";
  entryRevision: number;
  onLeaveReview: () => void;
  onSignIn: () => void;
  invitationDestination?: SpectatorInvitationDestination;
}
type Route =
  | "welcome"
  | "accounts"
  | "context"
  | "local"
  | "connected-review"
  | "auth"
  | "demo-login"
  | "privacy"
  | "help";
type ReviewService = Awaited<ReturnType<typeof discoverFictionalReview>>;

/** Account entry is shared by native and web. Fictional review is an explicit, separate journey. */
export function EntryApplication({
  renderLocalReview,
}: {
  renderLocalReview: (props: LocalReviewEntryProps) => ReactNode;
}) {
  const production = process.env.EXPO_PUBLIC_ENVIRONMENT === "production";
  const demoAccountLogin = !production && process.env.EXPO_PUBLIC_DEMO_ACCOUNT_LOGIN === "1";
  const [route, setRoute] = useState<Route>("welcome");
  const [demoEntryMode,setDemoEntryMode] = useState<"team"|"spectator"|"request">("team");
  const [intent, setIntent] = useState<"sign-in" | "activate">("sign-in");
  const [intentRevision, setIntentRevision] = useState(0);
  const [destination, setDestination] = useState<LongBallDestination | null>(
    null,
  );
  const [authOpened, setAuthOpened] = useState(false);
  const [localOpened, setLocalOpened] = useState(false);
  const [localEntryRevision, setLocalEntryRevision] = useState(0);
  const [localRole, setLocalRole] =
    useState<LocalReviewEntryProps["initialRole"]>("manager");
  const [reviewRole, setReviewRole] = useState<ReviewRole>("manager");
  const [reviewInvitation, setReviewInvitation] = useState<
    SpectatorInvitationDestination | undefined
  >();
  const reviewNavigationGuard = useRef<((leave: () => void) => void) | null>(
    null,
  );
  const retainReviewNavigationGuard = useCallback(
    (guard: ((leave: () => void) => void) | null) => {
      reviewNavigationGuard.current = guard;
    },
    [],
  );
  const [reviewService, setReviewService] = useState<ReviewService | null>(
    null,
  );
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const insets = useSafeAreaInsets();
  const openAuth = (nextIntent: "sign-in" | "activate") => {
    setIntent(nextIntent);
    setIntentRevision((value) => value + 1);
    setAuthOpened(true);
    setRoute("auth");
  };

  useEffect(() => {
    let active = true;
    const receive = (url: string) => {
      if (!active) return;
      const browserEntry =
        typeof window !== "undefined"
          ? `${window.location.origin}${window.location.pathname}`
          : null;
      const next = parseLongBallDestination(url, {
        httpsEntryUrls: [
          ...(process.env.EXPO_PUBLIC_LINK_ENTRY_URLS ?? "")
            .split(",")
            .map((value: string) => value.trim())
            .filter(Boolean),
          ...(browserEntry && window.location.protocol === "https:"
            ? [browserEntry]
            : []),
        ],
        developmentHttpEntryUrls:
          browserEntry &&
          typeof window !== "undefined" &&
          window.location.hostname === "localhost" &&
          (!production ||
            process.env.EXPO_PUBLIC_FICTIONAL_IDENTITY_TRIAL === "1")
            ? [browserEntry]
            : [],
        httpsOrigins: (process.env.EXPO_PUBLIC_LINK_ORIGINS ?? "")
          .split(",")
          .map((value: string) => value.trim())
          .filter(Boolean),
      });
      if (!next) return;
      // Retain the capability in memory before removing it from the address; links confer no role.
      setDestination(next);
      const enterDestination = () => {
        if (next.kind === "invitation") setRoute("welcome");
        else {
          setIntent("activate");
          setIntentRevision((value) => value + 1);
          setAuthOpened(true);
          setRoute("auth");
        }
      };
      if (reviewNavigationGuard.current)
        reviewNavigationGuard.current(enterDestination);
      else enterDestination();
      if (
        typeof window !== "undefined" &&
        window.location.href === url &&
        window.location.hash
      )
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
    };
    void Linking.getInitialURL().then((url) => {
      if (url) receive(url);
    });
    const subscription = Linking.addEventListener("url", (event) =>
      receive(event.url),
    );
    const browserChange = () => receive(window.location.href);
    if (typeof window !== "undefined")
      window.addEventListener("hashchange", browserChange);
    return () => {
      active = false;
      subscription.remove();
      if (typeof window !== "undefined")
        window.removeEventListener("hashchange", browserChange);
    };
  }, [production]);

  useEffect(() => {
    if (production || route !== "context") return;
    const controller = new AbortController();
    let active = true;
    void discoverFictionalReview({
      fictionalReviewChosen: true,
      fetch: globalThis.fetch,
      signal: controller.signal,
    })
      .then((result) => {
        if (active) setReviewService(result);
      })
      .catch(() => {
        if (active)
          setReviewService({
            status: "unavailable",
            reason: "status_unavailable",
            message:
              "The connected review service could not be reached. Retry, or use the on-this-device review.",
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [route, production, discoveryAttempt]);

  const content =
    route === "welcome" ? (
      <WelcomeScreen
        onSignIn={() => {if(demoAccountLogin){setDemoEntryMode("team");setRoute("demo-login");}else openAuth("sign-in");}}
        onActivate={() => openAuth("activate")}
        demoAccountLogin={demoAccountLogin}
        onSpectatorSignIn={demoAccountLogin ? () => {setDemoEntryMode("spectator");setRoute("demo-login");} : undefined}
        onRequestInvite={demoAccountLogin ? () => {setDemoEntryMode("request");setRoute("demo-login");} : undefined}
        onReview={production || demoAccountLogin ? undefined : () => setRoute("accounts")}
        onPrivacy={() => setRoute("privacy")}
        onHelp={() => setRoute("help")}
        invitationNotice={
          destination?.kind === "invitation"
            ? "You have a team invitation. Choose Spectator sign in / join to create your passcode or connect an existing account."
            : undefined
        }
      />
    ) : route === "demo-login" && demoAccountLogin ? (
      <DemoLoginApplication onInvitationHandled={() => setDestination(null)} initialMode={demoEntryMode} invitationDestination={destination?.kind === "invitation" ? destination.invitation : undefined} onBack={() => setRoute("welcome")} onNavigationGuardChange={retainReviewNavigationGuard} />
    ) : route === "accounts" ? (
      <ReviewAccountScreen
        onBack={() => setRoute("welcome")}
        onSelect={(role) => {
          setReviewService(null);
          setReviewRole(role);
          setRoute("context");
        }}
      />
    ) : route === "context" ? (
      <ScrollView
        contentContainerStyle={[
          s.page,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={s.column}>
          <Pill tone="muted">ROMA U10</Pill>
          <Text accessibilityRole="header" style={typography.title}>
            Choose your team space
          </Text>
          <Text style={typography.body}>
            Explore as {REVIEW_IDENTITIES[reviewRole].label}.
          </Text>
          <Card>
            <Text style={typography.section}>Richmond Rovers · Roma U10</Text>
            <Text style={typography.body}>
              2026/27 ·{" "}
              {reviewRole === "administrator"
                ? "Club administrator"
                : reviewRole === "player"
                  ? `${REVIEW_IDENTITIES.player.label} and household`
                  : reviewRole === "spectator"
                    ? "Invited spectator"
                    : "Assigned manager"}
            </Text>
            <Text style={typography.muted}>
              {reviewRole === "administrator"
                ? "Manage the club, teams, staff and season operations. Private match records require a separate assigned manager role."
                : reviewRole === "player"
                  ? "Your availability, your game, published photos and player preferences."
                  : reviewRole === "spectator"
                    ? "Permitted scores, results and published team photos."
                    : "Prepare the team, manage attendance and lineups, and review match reports."}
            </Text>
          </Card>
          {reviewRole !== "administrator" && (
            <Button
              label={
                reviewRole === "manager"
                  ? "Review matchday on this device"
                  : "Review on this device"
              }
              testID="review-open-local"
              variant="secondary"
              onPress={() => {
                setLocalRole(reviewRole);
                setLocalEntryRevision(value => value + 1);
                setLocalOpened(true);
                setRoute("local");
              }}
            />
          )}
          {reviewRole !== "administrator" && (
            <Text style={typography.muted}>
              Changes stay in this{" "}
              {Platform.OS === "web" ? "browser" : "phone"}. Use it for the full
              attendance → lineup → match-clock rehearsal.
            </Text>
          )}
          {!reviewService ? (
            <View style={s.loading}>
              <ActivityIndicator color={colors.brand} />
              <Text style={typography.muted}>Checking the connected workspace…</Text>
            </View>
          ) : reviewService.status === "available" ? (
            <>
              <Notice>
                Changes in the connected workspace are shared with other reviewers.
                This temporary session ends at{" "}
                {formatUkDateTime(reviewService.expiresAtMs)}
                .
              </Notice>
              <Button
                label="Open connected workspace"
                testID="review-open-connected"
                onPress={() => {
                  setReviewInvitation(
                    destination?.kind === "invitation"
                      ? destination.invitation
                      : undefined,
                  );
                  setRoute("connected-review");
                }}
              />
            </>
          ) : (
            <Notice tone="warning">{reviewService.message}</Notice>
          )}
          {reviewService?.status === "unavailable" && (
            <Button
              label="Check connected workspace again"
              variant="secondary"
              onPress={() => {
                setReviewService(null);
                setDiscoveryAttempt((value) => value + 1);
              }}
            />
          )}
          <Button
            label="Choose another role"
            variant="quiet"
            onPress={() => setRoute("accounts")}
          />
          <Button
            label="Back to Welcome"
            variant="quiet"
            onPress={() => setRoute("welcome")}
          />
        </View>
      </ScrollView>
    ) : route === "privacy" || route === "help" ? (
      <ScrollView
        contentContainerStyle={[
          s.page,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={s.column}>
          <Text style={typography.label}>
            LONGBALL · {route === "privacy" ? "PRIVACY" : "ACCOUNT HELP"}
          </Text>
          <Text accessibilityRole="header" style={typography.title}>
            {route === "privacy"
              ? "Your account and your team"
              : "Getting into LongBall"}
          </Text>
          <Card>
            <Text style={typography.body}>
              {route === "privacy"
                ? "LongBall uses one account with access limited to your authorised club, team, season and role. A player account shows that player’s permitted information. Spectator access is invitation based and can expire."
                : "Already have an account? Sign in once, then choose one of your authorised team spaces. Manager and administrator permissions are assigned separately; choosing a screen cannot grant them."}
            </Text>
            <Text style={typography.body}>
              {route === "privacy"
                ? "This Roma U10 workspace is for adult feedback. Do not enter real children’s personal information. Local changes stay on this device; connected changes are shared with other reviewers."
                : "For a child’s invited player account, the authorised household completes activation. Child email is not required. An existing account can accept a spectator invitation after sign-in."}
            </Text>
            <Text style={typography.body}>
              {route === "privacy"
                ? "After real sign-in, Account contains your devices, security settings and privacy requests. The production privacy, retention and recovery policies remain release decisions."
                : "A remembered native session may offer device authentication or a local PIN. Resetting that local unlock is different from recovering your account. Full account recovery uses the configured sign-in provider and authorised support route."}
            </Text>
          </Card>
          <Button label="Sign in" onPress={() => demoAccountLogin ? setRoute("demo-login") : openAuth("sign-in")} />
          <Button
            label="Activate account"
            variant="secondary"
            onPress={() => openAuth("activate")}
          />
          <Button
            label="Back to Welcome"
            variant="quiet"
            onPress={() => setRoute("welcome")}
          />
        </View>
      </ScrollView>
    ) : null;

  return (
    <View style={s.root}>
      {content}
      {authOpened && (
        <View style={[s.root, route !== "auth" && s.hidden]}>
          <ConnectedApplication
            visible={route === "auth"}
            initialIntent={intent}
            intentRevision={intentRevision}
            initialDestination={destination}
            onBackToWelcome={() => setRoute("welcome")}
            onEnterFictionalReview={
              production ? undefined : () => setRoute(demoAccountLogin ? "demo-login" : "accounts")
            }
          />
        </View>
      )}
      {localOpened && (
        <View style={[s.root, route !== "local" && s.hidden]}>
          {renderLocalReview({
            initialRole: localRole,
            entryRevision: localEntryRevision,
            onLeaveReview: () => setRoute("accounts"),
            onSignIn: () => openAuth("sign-in"),
            invitationDestination:
              destination?.kind === "invitation"
                ? destination.invitation
                : undefined,
          })}
        </View>
      )}
      {!production &&
        route === "connected-review" &&
        reviewService?.status === "available" && (
          <View style={s.root}>
              <FictionalReviewWorkspace
                initialConnection={{
                  baseUrl: reviewService.apiBaseUrl,
                  mode: "synthetic",
                  account: REVIEW_IDENTITIES[reviewRole].token,
                }}
                initialRole={reviewRole}
                onLeaveWorkspace={() => setRoute("accounts")}
                onOpenAccount={() => openAuth("sign-in")}
                onNavigationGuardChange={retainReviewNavigationGuard}
                invitationDestination={reviewInvitation}
              />
          </View>
        )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  hidden: { display: "none" },
  page: { flexGrow: 1, paddingHorizontal: 16, alignItems: "center" },
  column: { width: "100%", maxWidth: 600, gap: 16 },
  loading: { flexDirection: "row", alignItems: "center", gap: 12 },
});
