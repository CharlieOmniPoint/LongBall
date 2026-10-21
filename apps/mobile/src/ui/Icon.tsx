import Svg, { Circle, Path, Polygon, Rect } from "react-native-svg";
import { colors } from "./tokens";

export type IconName =
  | "ball"
  | "home"
  | "calendar"
  | "users"
  | "chart"
  | "more"
  | "arrow"
  | "left"
  | "check"
  | "clock"
  | "shield"
  | "swap"
  | "pause"
  | "play"
  | "info"
  | "chevron"
  | "settings"
  | "photo"
  | "trophy"
  | "lock";

/** Small original line drawings; visible control labels carry their meaning. */
export function Icon({
  name,
  size = 24,
  color = colors.ink,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const artwork = {
    ball: (
      <>
        <Circle cx="12" cy="12" r="9.2" />
        <Polygon
          points="12,7.7 16,10.6 14.5,15.2 9.5,15.2 8,10.6"
          fill={color}
          strokeWidth="1"
        />
        <Path d="m12 2.8 0 4.9m8.7 1.3-4.7 1.6m1.5 9-3-4.4m-8 4.4 3-4.4M3.3 9l4.7 1.6" />
      </>
    ),
    home: (
      <>
        <Path d="m3 10 9-7 9 7M5.5 9v12h5v-7h3v7h5V9" />
      </>
    ),
    calendar: (
      <>
        <Rect x="4" y="5" width="16" height="16" rx="2" />
        <Path d="M8 3v4m8-4v4M4 10h16m-12 4h1m3 0h1m3 0h1m-9 4h1m3 0h1" />
      </>
    ),
    users: (
      <>
        <Circle cx="9" cy="7" r="3" />
        <Path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v3" />
      </>
    ),
    chart: (
      <>
        <Path d="M5 21V12m7 9V4m7 17V8" strokeWidth="3" />
      </>
    ),
    more: (
      <>
        <Circle cx="5" cy="12" r="1.4" fill={color} />
        <Circle cx="12" cy="12" r="1.4" fill={color} />
        <Circle cx="19" cy="12" r="1.4" fill={color} />
      </>
    ),
    arrow: <Path d="M4 12h15m-6-6 6 6-6 6" />,
    left: <Path d="M20 12H5m6-6-6 6 6 6" />,
    check: <Path d="m4 12 5 5L20 6" strokeWidth="2.3" />,
    clock: (
      <>
        <Circle cx="12" cy="12" r="9" />
        <Path d="M12 6v6l4 2" />
      </>
    ),
    shield: (
      <Path d="M12 2.5c3 2 6 2.5 8 2.5v7c0 5-4 8-8 10-4-2-8-5-8-10V5c2 0 5-.5 8-2.5Z" />
    ),
    swap: (
      <>
        <Path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4" />
      </>
    ),
    pause: (
      <>
        <Path d="M8 5v14m8-14v14" strokeWidth="3.5" />
      </>
    ),
    play: <Polygon points="7,4 20,12 7,20" fill={color} strokeWidth="1" />,
    info: (
      <>
        <Circle cx="12" cy="12" r="9" />
        <Path d="M12 11v6" />
        <Circle cx="12" cy="7.4" r=".6" fill={color} />
      </>
    ),
    chevron: <Path d="m9 5 7 7-7 7" />,
    settings: (
      <>
        <Path d="m10 3-.5 2.2-2.3 1L5 5.5 3 9l1.8 1.5v3L3 15l2 3.5 2.2-.7 2.3 1L10 21h4l.5-2.2 2.3-1 2.2.7 2-3.5-1.8-1.5v-3L21 9l-2-3.5-2.2.7-2.3-1L14 3Z" />
        <Circle cx="12" cy="12" r="3" />
      </>
    ),
    photo: (
      <>
        <Rect x="3" y="4" width="18" height="16" rx="2" />
        <Circle cx="8" cy="9" r="1.5" />
        <Path d="m3 17 5-5 4 4 4-6 5 7" />
      </>
    ),
    trophy: (
      <>
        <Path d="M7 3h10v6a5 5 0 0 1-10 0V3ZM7 5H3v3c0 3 2 4 5 4m9-7h4v3c0 3-2 4-5 4M12 14v6m-4 1h8" />
      </>
    ),
    lock: (
      <>
        <Rect x="5" y="10" width="14" height="11" rx="2" />
        <Path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
      </>
    ),
  }[name];

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
      aria-hidden
    >
      {artwork}
    </Svg>
  );
}
