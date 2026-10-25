import { describe, expect, it } from "vitest";
import {
  createCommunityState,
  getCommunityView,
  syntheticCommunityActors,
} from "./community";
import {
  albumScopeKey,
  assertAlbumUploadTarget,
  captureAlbumUploadTarget,
  groupPermittedAlbums,
  resolveAlbumSelection,
  selectAlbum,
  type AlbumScope,
} from "./album-selection";
const at = Date.parse("2026-10-21T10:00:00Z");
const state = createCommunityState(at),
  actor = syntheticCommunityActors(state).manager;
const view = getCommunityView(state, actor, at);
const scope: AlbumScope = {
  apiBaseUrl: "http://127.0.0.1:4310",
  accountId: actor.accountId,
  issuer: "urn:fictional-issuer",
  subject: "fictional-subject",
  teamId: actor.teamId,
  seasonId: actor.seasonId,
  role: "manager",
};
const matches = [
  {
    ...view.matches[0],
    id: "game-old",
    label: "Roma vs Fictional Oak",
    playedAtMs: Date.parse("2026-09-20T00:00:00Z"),
  },
  {
    ...view.matches[0],
    id: "game-new",
    label: "Roma vs Fictional Birch",
    playedAtMs: Date.parse("2026-10-20T00:00:00Z"),
  },
];
const photos = [
  {
    ...view.gallery[0],
    id: "photo-new",
    matchId: "game-new",
    matchLabel: matches[1].label,
    playedAtMs: matches[1].playedAtMs!,
  },
  {
    ...view.gallery[0],
    id: "photo-old",
    matchId: "game-old",
    matchLabel: matches[0].label,
    playedAtMs: matches[0].playedAtMs!,
  },
];
describe("UI27/UI28 permitted game albums and immutable upload selection", () => {
  it("uses the configured team timezone across midnight and British summer time", () => {
    const late = [
      { ...matches[0], playedAtMs: Date.parse("2026-10-20T23:30:00Z") },
    ];
    expect(groupPermittedAlbums(late, [])[0].playedDate).toBe("2026-10-21");
    expect(
      groupPermittedAlbums(late, [], true, "America/New_York")[0].playedDate,
    ).toBe("2026-10-20");
    expect(
      groupPermittedAlbums(
        [{ ...late[0], playedAtMs: Date.parse("2026-12-20T23:30:00Z") }],
        [],
      )[0].playedDate,
    ).toBe("2026-12-20");
    expect(() =>
      groupPermittedAlbums(late, [], true, "Invalid/Timezone"),
    ).toThrow();
  });
  it("groups only current published DTO photos by game, with counts and newest played game first", () => {
    const input = JSON.stringify([matches, photos]);
    const albums = groupPermittedAlbums(matches, photos);
    expect(
      albums.map((item) => [item.matchId, item.playedDate, item.photoCount]),
    ).toEqual([
      ["game-new", "2026-10-20", 1],
      ["game-old", "2026-09-20", 1],
    ]);
    expect(albums[0].photos[0].id).toBe("photo-new");
    expect(JSON.stringify([matches, photos])).toBe(input);
    expect(
      groupPermittedAlbums([...matches].reverse(), [...photos].reverse()),
    ).toEqual(albums);
  });
  it("does not default to the first game or permit a withheld/unknown match selection", () => {
    expect(resolveAlbumSelection(scope, matches, null)).toBeNull();
    expect(() => captureAlbumUploadTarget(scope, matches, null)).toThrow(
      "Select the actual permitted game",
    );
    expect(() => selectAlbum(scope, matches, "unknown-game")).toThrow(
      "currently permitted",
    );
    expect(() =>
      selectAlbum(
        scope,
        [{ ...matches[0], sharingAllowed: false }],
        matches[0].id,
      ),
    ).toThrow("Withheld context");
    expect(selectAlbum(scope, matches, "game-old").matchId).toBe("game-old");
  });
  it("binds a choice to API, verified account/issuer/subject, role, player, team and season on the same render", () => {
    const ticket = selectAlbum(scope, matches, "game-old");
    for (const changed of [
      { ...scope, apiBaseUrl: "https://other.example/api" },
      { ...scope, accountId: "another-account" },
      { ...scope, issuer: "urn:other" },
      { ...scope, subject: "other-subject" },
      { ...scope, role: "spectator" as const },
      { ...scope, teamId: "other-team" },
      { ...scope, seasonId: "next-season" },
      { ...scope, playerId: "another-player" },
    ])
      expect(resolveAlbumSelection(changed, matches, ticket)).toBeNull();
    const player = {
      ...scope,
      role: "player" as const,
      playerId: "player-one",
    };
    const playerTicket = selectAlbum(player, matches, "game-old");
    expect(
      resolveAlbumSelection(
        { ...player, playerId: "player-two" },
        matches,
        playerTicket,
      ),
    ).toBeNull();
  });
  it("preserves an explicit choice across same-scope refresh and normalizes only a trailing API slash", () => {
    const ticket = selectAlbum(scope, matches, "game-old");
    expect(
      albumScopeKey({ ...scope, apiBaseUrl: `${scope.apiBaseUrl}/` }),
    ).toBe(albumScopeKey(scope));
    expect(
      resolveAlbumSelection({ ...scope }, [...matches].reverse(), ticket)?.id,
    ).toBe("game-old");
    expect(
      resolveAlbumSelection(
        scope,
        matches.filter((item) => item.id !== "game-old"),
        ticket,
      ),
    ).toBeNull();
    expect(
      resolveAlbumSelection(
        scope,
        matches.map((item) => ({ ...item, sharingAllowed: false })),
        ticket,
      ),
    ).toBeNull();
    expect(resolveAlbumSelection(scope, matches, ticket, false)).toBeNull();
  });
  it("keeps a captured upload target on its original game when a later chooser value changes", () => {
    const first = selectAlbum(scope, matches, "game-old"),
      target = captureAlbumUploadTarget(scope, matches, first);
    const second = selectAlbum(scope, matches, "game-new");
    expect(second.matchId).toBe("game-new");
    expect(target.matchId).toBe("game-old");
    expect(target).not.toBe(first);
    expect(() => assertAlbumUploadTarget(scope, matches, target)).not.toThrow();
    expect(() =>
      assertAlbumUploadTarget(
        { ...scope, accountId: "another-account" },
        matches,
        target,
      ),
    ).toThrow("Select the actual");
    expect(() =>
      assertAlbumUploadTarget(
        scope,
        matches.map((item) => ({ ...item, sharingAllowed: false })),
        target,
      ),
    ).toThrow("Select the actual");
  });
  it("allows a spectator to choose a permitted published album while refusing upload capability", () => {
    const spectator = { ...scope, role: "spectator" as const };
    const choice = selectAlbum(spectator, matches, "game-new");
    expect(resolveAlbumSelection(spectator, matches, choice)?.id).toBe(
      "game-new",
    );
    expect(() => captureAlbumUploadTarget(spectator, matches, choice)).toThrow(
      "Spectator access",
    );
  });
  it("never derives unknown played dates from photo/upload timing or leaks withheld photos/counts", () => {
    const hidden = {
      ...matches[1],
      id: "game-withheld",
      sharingAllowed: false,
      label: "Forbidden match context",
    };
    const unknown = {
      ...matches[0],
      id: "game-unknown-date",
      playedAtMs: null,
    };
    const extra = [
      ...photos,
      {
        ...photos[0],
        id: "forbidden-photo",
        matchId: hidden.id,
        caption: "Forbidden private caption",
      },
      {
        ...photos[0],
        id: "orphan-photo",
        matchId: "not-in-service-view",
        caption: "Forbidden orphan caption",
      },
    ];
    const albums = groupPermittedAlbums([...matches, hidden, unknown], extra);
    expect(albums.at(-1)).toMatchObject({
      matchId: "game-unknown-date",
      playedAtMs: null,
      playedDate: null,
      photoCount: 0,
    });
    expect(JSON.stringify(albums)).not.toContain("Forbidden");
    expect(groupPermittedAlbums(matches, extra, false)).toEqual([]);
  });
  it("fails closed on ambiguous game/photo identities and invalid unscoped URLs", () => {
    expect(() =>
      groupPermittedAlbums([...matches, matches[0]], photos),
    ).toThrow("ambiguous");
    expect(() => groupPermittedAlbums(matches, [...photos, photos[0]])).toThrow(
      "ambiguous",
    );
    expect(() => albumScopeKey({ ...scope, apiBaseUrl: "/" })).toThrow();
    expect(() =>
      albumScopeKey({
        ...scope,
        apiBaseUrl: "https://user:secret@example.test",
      }),
    ).toThrow("without credentials");
    expect(() =>
      albumScopeKey({ ...scope, role: "player", playerId: null }),
    ).toThrow("current verified");
  });
});
