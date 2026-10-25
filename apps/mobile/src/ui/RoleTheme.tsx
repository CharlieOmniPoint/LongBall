import { createContext, useContext, type ReactNode } from "react";
import type { Principal, Role } from "@longball/application/access";

export interface RolePalette {
  accent: string;
  pressed: string;
  tint: string;
  canvas: string;
}
const green: RolePalette = {
  accent: "#126946",
  pressed: "#0D4F35",
  tint: "#E4F1E9",
  canvas: "#F6F8F7",
};
const blue: RolePalette = {
  accent: "#1557A5",
  pressed: "#10417C",
  tint: "#E7F0FC",
  canvas: "#F5F8FD",
};
const purple: RolePalette = {
  accent: "#713AA2",
  pressed: "#542879",
  tint: "#F0E8F8",
  canvas: "#F9F6FC",
};
const Context = createContext<RolePalette>(green);
export const useRoleTheme = () => useContext(Context);
export function RoleThemeProvider({
  role,
  superAdmin,
  children,
}: {
  role: Role | null;
  superAdmin?: boolean;
  children: ReactNode;
}) {
  return (
    <Context.Provider
      value={superAdmin ? purple : role === "spectator" ? blue : green}
    >
      {children}
    </Context.Provider>
  );
}
/** Display metadata never grants authority. */
export function accountRoleLabel(
  principal: Principal | null | undefined,
  role: Role | null | undefined,
): string {
  const administration = principal?.administration;
  if (administration?.level === "super")
    return role === "manager" ? "Super Admin · Manager" : "Super Admin";
  if (administration?.level === "club")
    return role === "manager" ? "Club Admin · Manager" : "Club Admin";
  return role
    ? {
        administrator: "Club Admin",
        manager: "Manager",
        player: "Player",
        spectator: "Spectator",
      }[role]
    : "Account";
}
