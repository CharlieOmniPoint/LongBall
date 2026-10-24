import type { CommunityActor, getCommunityView } from "./community";

type CommunityView = ReturnType<typeof getCommunityView>;
export type AlbumMatch = CommunityView["matches"][number];
export type AlbumPhoto = CommunityView["gallery"][number];
/** A stable presentation scope, never a new permission grant. Excludes refresh generation. */
export interface AlbumScope {
  apiBaseUrl: string;
  accountId: string;
  issuer: string;
  subject: string;
  teamId: string;
  seasonId: string;
  role: CommunityActor["role"];
  playerId?: string | null;
}
export interface AlbumSelection {
  scopeKey: string;
  matchId: string;
}
export interface GameAlbum {
  matchId: string;
  label: string;
  playedAtMs: number | null;
  playedDate: string | null;
  photoCount: number;
  photos: AlbumPhoto[];
}
const order = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
export function albumScopeKey(scope: AlbumScope): string {
  if (
    ![
      scope.apiBaseUrl,
      scope.accountId,
      scope.issuer,
      scope.subject,
      scope.teamId,
      scope.seasonId,
    ].every((value) => typeof value === "string" && value.trim().length > 0) ||
    !["manager", "player", "spectator"].includes(scope.role) ||
    (scope.role === "player" && !scope.playerId)
  )
    throw new Error(
      "Album selection needs the current verified account, API, role, team and season scope.",
    );
  const api = new URL(scope.apiBaseUrl);
  if (
    !["https:", "http:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  )
    throw new Error(
      "Use the current absolute API origin/path without credentials for album selection.",
    );
  const base = `${api.origin}${api.pathname.replace(/\/+$/, "")}`;
  return JSON.stringify([
    base,
    scope.accountId,
    scope.issuer,
    scope.subject,
    scope.teamId,
    scope.seasonId,
    scope.role,
    scope.playerId ?? null,
  ]);
}
function validateIdentities(matches: AlbumMatch[], photos: AlbumPhoto[]) {
  if (
    new Set(matches.map((match) => match.id)).size !== matches.length ||
    matches.some((match) => !match.id)
  )
    throw new Error(
      "Album game identities are ambiguous. Refresh the authorised service view.",
    );
  if (
    new Set(photos.map((photo) => photo.id)).size !== photos.length ||
    photos.some((photo) => !photo.id)
  )
    throw new Error(
      "Published photo identities are ambiguous. Refresh the authorised service view.",
    );
}
/** Only server-filtered published gallery rows count. Pending/review/private sources are never input. */
export function groupPermittedAlbums(
  matches: AlbumMatch[],
  photos: AlbumPhoto[],
  allowed = true,
  timeZone = "Europe/London",
): GameAlbum[] {
  if (!allowed) return [];
  validateIdentities(matches, photos);
  const dates = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return matches
    .filter((match) => match.sharingAllowed === true)
    .map((match) => {
      const playedAtMs =
        typeof match.playedAtMs === "number" &&
        Number.isSafeInteger(match.playedAtMs) &&
        match.playedAtMs >= 0 &&
        Number.isFinite(new Date(match.playedAtMs).getTime())
          ? match.playedAtMs
          : null;
      const visible = photos
        .filter((photo) => photo.matchId === match.id)
        .map((photo) => ({ ...photo }))
        .sort((left, right) => order(left.id, right.id));
      return {
        matchId: match.id,
        label: match.label,
        playedAtMs,
        playedDate:
          playedAtMs === null
            ? null
            : (() => {
                const parts = dates.formatToParts(playedAtMs);
                return ["year", "month", "day"]
                  .map(
                    (name) => parts.find((part) => part.type === name)!.value,
                  )
                  .join("-");
              })(),
        photoCount: visible.length,
        photos: visible,
      };
    })
    .sort(
      (left, right) =>
        (right.playedAtMs ?? -1) - (left.playedAtMs ?? -1) ||
        order(left.matchId, right.matchId),
    );
}
/** Called after an explicit game choice. No first-game/default selection exists. */
export function selectAlbum(
  scope: AlbumScope,
  matches: AlbumMatch[],
  matchId: string,
  allowed = true,
): AlbumSelection {
  const albums = groupPermittedAlbums(matches, [], allowed);
  if (!albums.some((album) => album.matchId === matchId))
    throw new Error(
      "Choose a game currently permitted by this service view. Withheld context cannot be selected or inferred.",
    );
  return { scopeKey: albumScopeKey(scope), matchId };
}
/** A mismatched account/API/role/team/season ticket never survives even one render. */
export function resolveAlbumSelection(
  scope: AlbumScope,
  matches: AlbumMatch[],
  selection: AlbumSelection | null,
  allowed = true,
): AlbumMatch | null {
  if (!allowed || !selection || selection.scopeKey !== albumScopeKey(scope))
    return null;
  validateIdentities(matches, []);
  return (
    matches.find(
      (match) =>
        match.id === selection.matchId && match.sharingAllowed === true,
    ) ?? null
  );
}
/** Capture this immutable target in an upload job; changing the chooser must not retarget a retry. */
export function captureAlbumUploadTarget(
  scope: AlbumScope,
  matches: AlbumMatch[],
  selection: AlbumSelection | null,
  allowed = true,
): AlbumSelection {
  if (scope.role === "spectator")
    throw new Error("Spectator access does not authorize image uploads.");
  const match = resolveAlbumSelection(scope, matches, selection, allowed);
  if (!match || !selection)
    throw new Error(
      "Select the actual permitted game before choosing an image for upload.",
    );
  return { scopeKey: selection.scopeKey, matchId: match.id };
}
export function assertAlbumUploadTarget(
  scope: AlbumScope,
  matches: AlbumMatch[],
  target: AlbumSelection,
  allowed = true,
): void {
  captureAlbumUploadTarget(scope, matches, target, allowed);
}
