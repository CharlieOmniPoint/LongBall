import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import type { LogoReference } from "@longball/application/branding";
import { base64Url } from "@longball/application/security";
import {
  BrandMediaClient,
  logoReferenceKey,
  readCurrentBrandImage,
} from "../platform/brand-media-client";
import { colors, Icon } from "../ui";

export function BrandBadge({
  uri = null,
  label,
  size = 48,
  onLoad,
  onError,
}: {
  uri?: string | null;
  label: string;
  size?: number;
  onLoad?: () => void;
  onError?: () => void;
}) {
  return (
    <View
      accessible={!uri}
      accessibilityRole="image"
      accessibilityLabel={uri ? undefined : label}
      style={[styles.frame, { width: size, height: size }]}
    >
      {uri ? (
        <Image
          onLoad={onLoad}
          onError={onError}
          source={{ uri, cache: "reload" }}
          accessibilityLabel={label}
          style={{ width: size - 4, height: size - 4, resizeMode: "contain" }}
        />
      ) : (
        <Icon
          name="shield"
          color={colors.brand}
          size={Math.round(size * 0.56)}
        />
      )}
    </View>
  );
}
export interface AuthenticatedBrandBadgeProps {
  client: BrandMediaClient;
  reference: LogoReference | null;
  scopeKey: string;
  assertAccess: () => Promise<void>;
  label: string;
  size?: number;
  mode?: "own" | "published";
  onViewed?: (key: string | null) => void;
  showError?: boolean;
}
/** Only a current authenticated, metadata-free PNG derivative is held in memory. */
export function AuthenticatedBrandBadge(props: AuthenticatedBrandBadgeProps) {
  const assetKey = props.reference
    ? logoReferenceKey(props.reference)
    : "neutral";
  return (
    <BoundBrandBadge
      key={`${props.scopeKey}:${assetKey}:${props.mode ?? "published"}`}
      {...props}
    />
  );
}
function BoundBrandBadge({
  client,
  reference,
  assertAccess,
  scopeKey,
  label,
  size = 48,
  mode = "published",
  onViewed,
  showError = false,
}: AuthenticatedBrandBadgeProps) {
  const [uri, setUri] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ assertAccess, onViewed, client });
  useLayoutEffect(() => {
    callbacks.current = { assertAccess, onViewed, client };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    if (!reference)
      return () => {
        alive = false;
      };
    void (async () => {
      try {
        const bytes = await readCurrentBrandImage(
          callbacks.current.client,
          reference,
          mode,
          size <= 96 ? "thumbnail" : "display",
          () => callbacks.current.assertAccess(),
        );
        if (!alive) return;
        const encoded = base64Url(bytes)
          .replaceAll("-", "+")
          .replaceAll("_", "/");
        setUri(
          `data:image/png;base64,${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`,
        );
      } catch (cause) {
        if (alive) {
          setUri(null);
          setError(
            cause instanceof Error
              ? cause.message
              : "The current logo is unavailable.",
          );
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [reference, mode, scopeKey, size]);
  return (
    <View style={styles.stack}>
      <BrandBadge
        uri={uri}
        label={label}
        size={size}
        onError={() => {
          setUri(null);
          setError(
            "The processed logo could not be displayed. Refresh and review the current revision before publishing.",
          );
          callbacks.current.onViewed?.(null);
        }}
        onLoad={() => {
          if (reference)
            void callbacks.current
              .assertAccess()
              .then(() => {
                if (mounted.current)
                  callbacks.current.onViewed?.(logoReferenceKey(reference));
              })
              .catch(() => {
                if (mounted.current) {
                  setUri(null);
                  callbacks.current.onViewed?.(null);
                }
              });
        }}
      />
      {showError && error && (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  frame: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  stack: { gap: 8 },
  error: { color: colors.errorInk, fontSize: 14, lineHeight: 21 },
});
