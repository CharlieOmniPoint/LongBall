import { useMemo, useState } from "react";
import { Linking, Share, Text, TextInput, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import createQrCode from "qrcode-generator";
import { Button, Notice, colors, typography } from "../ui";

/** Encodes the exact scoped invitation locally. No external QR service receives its credential. */
export function InvitationShare({
  url,
  disabled = false,
}: {
  url: string;
  disabled?: boolean;
}) {
  const [qr, setQr] = useState(false),
    [email, setEmail] = useState(""),
    [error, setError] = useState<string | null>(null);
  const matrix = useMemo(() => {
    try {
      const code = createQrCode(0, "M");
      code.addData(url, "Byte");
      code.make();
      const size = code.getModuleCount();
      let path = "";
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          if (code.isDark(y, x)) path += `M${x + 4},${y + 4}h1v1h-1z`;
      return { size: size + 8, path };
    } catch {
      return null;
    }
  }, [url]);
  return (
    <View style={{ gap: 10 }} testID="spectator-invitation-share">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          compact
          label={qr ? "Hide QR code" : "Show QR code"}
          variant="secondary"
          disabled={disabled || !matrix}
          onPress={() => setQr(!qr)}
          testID="invitation-show-qr"
        />
        <Button
          compact
          label="Share invitation"
          variant="secondary"
          disabled={disabled}
          onPress={() => {
            void Share.share({
              message: `Join our team on LongBall: ${url}`,
              url,
            }).catch(() =>
              setError(
                "Sharing could not be opened. You can select and copy the link.",
              ),
            );
          }}
        />
      </View>
      {qr && matrix && (
        <View
          style={{
            alignSelf: "center",
            maxWidth: "100%",
            padding: 8,
            backgroundColor: "#fff",
          }}
          accessibilityLabel="QR code for this team invitation"
          testID="invitation-qr-code"
        >
          <Svg
            width={224}
            height={224}
            viewBox={`0 0 ${matrix.size} ${matrix.size}`}
          >
            <Rect
              x={0}
              y={0}
              width={matrix.size}
              height={matrix.size}
              fill="#fff"
            />
            <Path d={matrix.path} fill="#000" />
          </Svg>
        </View>
      )}
      <TextInput
        accessibilityLabel="Invitation recipient email"
        value={email}
        onChangeText={setEmail}
        placeholder="Email address (optional)"
        autoCapitalize="none"
        keyboardType="email-address"
        style={{
          minHeight: 44,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 10,
          paddingHorizontal: 12,
          ...typography.body,
        }}
      />
      <Button
        compact
        label="Invite by email"
        variant="secondary"
        disabled={disabled}
        onPress={() => {
          setError(null);
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            setError(
              "Enter a valid email address, or leave it blank to choose in your email app.",
            );
            return;
          }
          void Linking.openURL(
            `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent("Your LongBall team invitation")}&body=${encodeURIComponent(`Join our team on LongBall. Open this private invitation to create your spectator account and set a four-digit passcode:\n\n${url}`)}`,
          ).catch(() =>
            setError(
              "An email app could not be opened. Use Share invitation or copy the link.",
            ),
          );
        }}
      />
      <Text style={typography.muted}>
        Email opens your email app so you can review and send the invitation.
      </Text>
      {error && <Notice tone="warning">{error}</Notice>}
    </View>
  );
}
