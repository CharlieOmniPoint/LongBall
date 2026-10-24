import {
  Children,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type ComponentRef,
} from "react";
import {
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { Role } from "@longball/application/access";
import {
  resolveWorkspaceLayout,
  staffLayoutRole,
  type WorkspaceLayoutPreference,
} from "@longball/application/workspace-layout";
import {
  readLayoutPreference,
  saveLayoutPreference,
} from "../platform/workspace-layout-preference";
import { Button } from "./Button";
import { colors, typography } from "./tokens";

type Layout = ReturnType<typeof resolveWorkspaceLayout>;
const LayoutContext = createContext<Layout>(
  resolveWorkspaceLayout({
    role: null,
    preference: "auto",
    width: 390,
    height: 844,
  }),
);
type Choice = {
  preference: WorkspaceLayoutPreference;
  select: (value: WorkspaceLayoutPreference) => void;
  error: boolean;
  open: boolean;
  toggle: () => void;
  menuRef: RefObject<ComponentRef<typeof View> | null>;
};
const ChoiceContext = createContext<Choice | null>(null);
export const useWorkspaceLayout = () => useContext(LayoutContext);

export function WorkspaceLayoutProvider({
  role,
  children,
}: {
  role: Role | null;
  children: ReactNode;
}) {
  const dimensions = useWindowDimensions();
  const [choice, setChoice] = useState<{
    role: Role | null;
    preference: WorkspaceLayoutPreference;
  }>({ role: null, preference: "auto" });
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const generation = useRef(0),
    focusGeneration = useRef(0),
    menuRef = useRef<ComponentRef<typeof View> | null>(null),
    writes = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const ticket = ++generation.current;
    ++focusGeneration.current;
    let active = true;
    if (!staffLayoutRole(role)) return;
    void writes.current
      .catch(() => undefined)
      .then(() => readLayoutPreference())
      .then((preference) => {
        if (active && generation.current === ticket)
          setChoice({ role, preference });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [role]);
  const preference = choice.role === role ? choice.preference : "auto";
  const select = (value: WorkspaceLayoutPreference) => {
    if (!staffLayoutRole(role)) return;
    ++generation.current;
    setChoice({ role, preference: value });
    setOpen(false);
    setError(false);
    const focusTicket = ++focusGeneration.current;
    requestAnimationFrame(() => {
      if (focusGeneration.current === focusTicket) menuRef.current?.focus();
    });
    writes.current = writes.current
      .catch(() => undefined)
      .then(() => saveLayoutPreference(value))
      .catch(() => setError(true));
  };
  const layout = useMemo(
    () =>
      resolveWorkspaceLayout({
        role,
        preference,
        width: dimensions.width,
        height: dimensions.height,
        fontScale: dimensions.fontScale,
      }),
    [
      role,
      preference,
      dimensions.width,
      dimensions.height,
      dimensions.fontScale,
    ],
  );
  return (
    <ChoiceContext.Provider
      value={{
        preference,
        select,
        error,
        open,
        toggle: () => {
          ++focusGeneration.current;
          setOpen((value) => !value);
        },
        menuRef,
      }}
    >
      <LayoutContext.Provider value={layout}>{children}</LayoutContext.Provider>
    </ChoiceContext.Provider>
  );
}

/** Keeps the same subtree mounted while measuring actual nested panel width. */
export function WorkspaceLayoutScope({
  children,
  style,
  testID,
  estimatedWidth,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  estimatedWidth?: number;
}) {
  const parent = useWorkspaceLayout();
  const [measured, setMeasured] = useState<{
    parentWidth: number;
    width: number;
  } | null>(null);
  const width =
    measured?.parentWidth === parent.contentWidth
      ? measured.width
      : (estimatedWidth ?? parent.contentWidth);
  const value = {
    ...parent,
    rail: false,
    contentWidth: width,
    wide:
      parent.mode === "tablet" &&
      parent.viewportHeight >= 480 &&
      width >= 700 * Math.min(parent.fontScale, 1.5),
  };
  return (
    <View
      style={style}
      testID={testID}
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        setMeasured((previous) =>
          previous?.parentWidth === parent.contentWidth &&
          Math.abs(previous.width - next) < 1
            ? previous
            : { parentWidth: parent.contentWidth, width: next },
        );
      }}
    >
      <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
    </View>
  );
}

export function WorkspaceColumns({
  children,
  style,
  testID,
  ratio = 1,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  ratio?: number;
}) {
  const layout = useWorkspaceLayout(),
    items = Children.toArray(children),
    first = Math.min(3, Math.max(0.3, ratio));
  const available = Math.max(
    0,
    layout.contentWidth - 16 * Math.max(0, items.length - 1),
  );
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: layout.wide ? "row" : "column",
          alignItems: "stretch",
          gap: 16,
          minWidth: 0,
        },
        style,
      ]}
    >
      {items.map((child, index) => (
        <WorkspaceLayoutScope
          key={index}
          estimatedWidth={
            layout.wide
              ? (available * (index === 0 ? first : 1)) /
                (first + items.length - 1)
              : layout.contentWidth
          }
          style={{
            minWidth: 0,
            flexGrow: layout.wide ? (index === 0 ? first : 1) : 0,
            flexShrink: 1,
            flexBasis: layout.wide ? 0 : "auto",
          }}
        >
          {child}
        </WorkspaceLayoutScope>
      ))}
    </View>
  );
}

export function WorkspaceLayoutMenuButton({
  compact = true,
}: {
  compact?: boolean;
}) {
  const layout = useWorkspaceLayout(),
    choice = useContext(ChoiceContext);
  if (!layout.staff || !choice) return null;
  return (
    <Button
      label={`Layout: ${choice.preference[0].toUpperCase() + choice.preference.slice(1)}`}
      accessibilityLabel={`Change display layout, ${choice.preference} selected`}
      accessibilityState={{ expanded: choice.open || choice.error }}
      buttonRef={choice.menuRef}
      icon="layout"
      iconOnly={compact}
      compact
      variant="quiet"
      testID="workspace-layout-menu"
      onPress={choice.toggle}
    />
  );
}

export function WorkspaceLayoutControls() {
  const layout = useWorkspaceLayout(),
    choice = useContext(ChoiceContext);
  if (!layout.staff || !choice) return null;
  return (
    <View
      style={{
        display: choice.open || choice.error ? "flex" : "none",
        gap: 8,
        minWidth: 0,
        padding: 8,
        backgroundColor: colors.surface,
        borderRadius: 8,
      }}
      testID="workspace-layout-controls"
    >
      <Text style={typography.label}>Display layout</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(["auto", "phone", "tablet"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={`${value[0].toUpperCase() + value.slice(1)} layout`}
            accessibilityState={{ selected: value === choice.preference }}
            aria-pressed={value === choice.preference}
            testID={`workspace-layout-choice-${value}`}
            onPress={() => choice.select(value)}
            style={{
              minHeight: 44,
              minWidth: 70,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 12,
              borderRadius: 8,
              borderWidth: 2,
              borderColor:
                value === choice.preference
                  ? colors.brand
                  : colors.controlBorder,
              backgroundColor:
                value === choice.preference ? colors.brand : colors.surface,
            }}
          >
            <Text
              style={[
                typography.label,
                {
                  color:
                    value === choice.preference ? colors.surface : colors.brand,
                },
              ]}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={typography.muted}>
        {layout.mode === "tablet" && !layout.wide
          ? "Tablet view adapts to this compact window."
          : "Remembered on this device. Auto follows the available screen space."}
      </Text>
      {choice.error && (
        <Text style={typography.muted}>
          This layout is active. Your device could not remember the choice.
        </Text>
      )}
    </View>
  );
}
