import { formatUkSeasonLabel } from "@longball/application/uk-display";
import { useEffect, useRef, useState } from "react";
import { AppState, Text, TextInput, View } from "react-native";
import {
  pinProblem,
  suggestInitialUsername,
  usernameProblem,
  type SignInRules,
} from "@longball/application/identity-policy";
import { invitationTeamLabel } from "@longball/application/invitation-context";
import {
  previewSpectatorInvite,
  loadSpectatorSignInRules,
  signInSpectatorPin,
  type SpectatorInvitePreview,
} from "../platform/spectator-access-client";
import type { DemoLoginSession } from "../platform/demo-login";
import { randomUUID } from "../platform/id";
import { Button, Card, Notice, colors, typography } from "../ui";

type SpectatorPinEntryProps = {
  apiBaseUrl: string;
  invitation?: { code: string };
  onSignedIn: (session: DemoLoginSession) => void;
  onBack: () => void;
};
export function SpectatorPinEntry(props: SpectatorPinEntryProps) {
  return (
    <SpectatorPinSession
      key={`${props.apiBaseUrl}:${props.invitation?.code ?? "login"}`}
      {...props}
    />
  );
}
function SpectatorPinSession({
  apiBaseUrl,
  invitation,
  onSignedIn,
  onBack,
}: SpectatorPinEntryProps) {
  const [register, setRegister] = useState(Boolean(invitation)),
    [fullName, setFullName] = useState(""),
    [username, setUsername] = useState(""),
    [usernameEdited, setUsernameEdited] = useState(false),
    [pin, setPin] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [preview, setPreview] = useState<SpectatorInvitePreview | null>(null),
    [rules, setRules] = useState<SignInRules | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null),
    mounted = useRef(true),
    requestId = useRef(randomUUID());
  useEffect(() => {
    mounted.current = true;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        operation.current?.abort();
        setPin("");
        setConfirmation("");
      }
    });
    return () => {
      mounted.current = false;
      operation.current?.abort();
      sub.remove();
    };
  }, []);
  const invitationCode = invitation?.code;
  useEffect(() => {
    if (!invitationCode) return;
    const controller = new AbortController();
    operation.current = controller;
    void Promise.all([
      previewSpectatorInvite(apiBaseUrl, invitationCode, controller.signal),
      loadSpectatorSignInRules(apiBaseUrl, controller.signal),
    ])
      .then(([value, currentRules]) => {
        if (mounted.current && !controller.signal.aborted) {
          setPreview(value);
          setRules(currentRules);
        }
      })
      .catch(() => {
        if (mounted.current && !controller.signal.aborted)
          setError(
            "The invitation and current sign-in rules could not be reviewed. Ask for a current link, or sign in to your existing account.",
          );
      })
      .finally(() => {
        if (operation.current === controller) operation.current = null;
      });
    return () => controller.abort();
  }, [apiBaseUrl, invitationCode]);
  const suggestion =
    preview && rules && fullName.trim()
      ? suggestInitialUsername(preview.context.teamName, fullName, [], rules)
      : "";
  const enteredUsername =
    register && !usernameEdited && suggestion ? suggestion : username;
  const submit = async () => {
    if (operation.current || busy) return;
    setError(null);
    if (register) {
      if (!preview || !rules) {
        setError("Review a current team invitation and sign-in rules first.");
        return;
      }
      const problem =
        usernameProblem(enteredUsername, rules) || pinProblem(pin, rules);
      if (problem) {
        setError(problem);
        return;
      }
      if (pin !== confirmation) {
        setError("The two passcodes do not match.");
        return;
      }
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    const submittedPin = pin;
    setPin("");
    setConfirmation("");
    try {
      const session = await signInSpectatorPin({
        apiBaseUrl,
        username: enteredUsername,
        passcode: submittedPin,
        register,
        token: invitation?.code,
        requestId: requestId.current,
        ...(register && rules ? { rules } : {}),
        signal: controller.signal,
      });
      if (mounted.current && !controller.signal.aborted) onSignedIn(session);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Spectator sign-in could not be completed.",
        );
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const input = {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    ...typography.body,
  };
  return (
    <Card testID="spectator-pin-entry">
      <Text style={typography.section}>
        {register ? "Join as a Spectator" : "Spectator sign in"}
      </Text>
      {preview && (
        <Text style={typography.body} testID="spectator-pin-context">
          {preview.context.clubName} · {invitationTeamLabel(preview.context)} ·{" "}
          {preview.context.seasonLabel
            ? formatUkSeasonLabel(preview.context.seasonLabel)
            : ""}
        </Text>
      )}
      <Text style={typography.body}>
        {register
          ? `Choose a username and a four-digit passcode.${rules?.spectatorPin.blockSimpleCodes ? " Avoid repeated digits, sequences and repeated pairs." : ""}`
          : "Enter your username and four-digit passcode. Your invited teams will appear after sign-in."}
      </Text>
      {register && (
        <>
          <TextInput
            value={fullName}
            onChangeText={setFullName}
            placeholder="Your name (optional)"
            accessibilityLabel="Your name for username suggestion"
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={100}
            editable={!busy}
            style={input}
            testID="spectator-signup-name"
          />
          <Text style={typography.muted}>
            Your name suggests a username such as Roma.SebL. You can edit it
            below.
          </Text>
          {suggestion && usernameEdited && enteredUsername !== suggestion && (
            <Button
              compact
              variant="quiet"
              label={`Use ${suggestion}`}
              disabled={busy}
              onPress={() => setUsernameEdited(false)}
              testID="spectator-use-suggested-username"
            />
          )}
        </>
      )}
      <TextInput
        value={enteredUsername}
        onChangeText={(value) => {
          setUsername(value);
          setUsernameEdited(true);
        }}
        placeholder="Username"
        accessibilityLabel="Spectator username"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={40}
        editable={!busy}
        style={input}
        testID="spectator-pin-username"
      />
      {register && (
        <Text style={typography.muted}>
          Usernames ignore capitals. If a name is already taken, add
          {rules?.username.allowNumbers ? " a number" : " another letter"} or
          choose another name.
        </Text>
      )}
      <TextInput
        value={pin}
        onChangeText={(value) => setPin(value.replace(/\D/g, "").slice(0, 4))}
        placeholder="Four-digit passcode"
        accessibilityLabel="Spectator passcode"
        secureTextEntry
        keyboardType="number-pad"
        maxLength={4}
        editable={!busy}
        style={input}
        testID="spectator-pin-passcode"
      />
      {register && (
        <TextInput
          value={confirmation}
          onChangeText={(value) =>
            setConfirmation(value.replace(/\D/g, "").slice(0, 4))
          }
          placeholder="Repeat passcode"
          accessibilityLabel="Repeat spectator passcode"
          secureTextEntry
          keyboardType="number-pad"
          maxLength={4}
          editable={!busy}
          style={input}
          testID="spectator-pin-confirmation"
        />
      )}
      {error && <Notice tone="warning">{error}</Notice>}
      <Button
        label={
          busy
            ? "Please wait…"
            : register
              ? "Create spectator account"
              : "Sign in as Spectator"
        }
        testID="spectator-pin-submit"
        disabled={
          busy ||
          !enteredUsername.trim() ||
          pin.length !== 4 ||
          (register && (!preview || !rules || confirmation.length !== 4))
        }
        onPress={() => {
          void submit();
        }}
      />
      {invitation && (
        <Button
          label={
            register
              ? "I already have a spectator account"
              : "Create a new spectator account"
          }
          variant="quiet"
          disabled={busy}
          onPress={() => {
            setUsername(enteredUsername);
            setUsernameEdited(true);
            setRegister(!register);
            setError(null);
            setPin("");
            setConfirmation("");
          }}
        />
      )}
      <View style={{ flexDirection: "row" }}>
        <Button label="Back" variant="quiet" disabled={busy} onPress={onBack} />
      </View>
    </Card>
  );
}
