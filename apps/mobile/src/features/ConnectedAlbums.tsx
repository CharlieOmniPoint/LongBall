import { formatUkDate } from "@longball/application/uk-display";
import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  albumScopeKey,
  groupPermittedAlbums,
  resolveAlbumSelection,
  selectAlbum,
  type AlbumMatch,
  type AlbumPhoto,
  type AlbumScope,
  type AlbumSelection,
} from "@longball/application/album-selection";
import { Button, Card, Notice, Pill } from "../ui/Button";
import { colors, typography } from "../ui/tokens";

export interface ConnectedAlbumsProps {
  scope: AlbumScope;
  allowed: boolean;
  matches: AlbumMatch[];
  photos: AlbumPhoto[];
  selection: AlbumSelection | null;
  onSelect: (selection: AlbumSelection | null) => void;
  disabled?: boolean;
  timeZone?: string;
  renderThumbnail?: (photo: AlbumPhoto) => ReactNode;
  renderPhoto?: (photo: AlbumPhoto) => ReactNode;
}
/** Pure DTO grouping plus a scoped chooser. The authenticated gateway still checks every image. */
export function ConnectedAlbums(props: ConnectedAlbumsProps) {
  const [opened, setOpened] = useState<{
    scopeKey: string;
    matchId: string;
    photoId: string;
  } | null>(null);
  const model = useMemo(() => {
    try {
      const key = albumScopeKey(props.scope);
      const permitted = groupPermittedAlbums(
        props.matches,
        props.photos,
        props.allowed,
        props.timeZone,
      );
      // Spectators browse published photos; empty games remain available to
      // contributors so they can deliberately choose their upload target.
      const albums =
        props.scope.role === "spectator"
          ? permitted.filter((album) => album.photoCount > 0)
          : permitted;
      const chosen = resolveAlbumSelection(
        props.scope,
        props.matches,
        props.selection,
        props.allowed,
      );
      return {
        key,
        albums,
        chosen: chosen
          ? (albums.find((album) => album.matchId === chosen.id) ?? null)
          : null,
        error: null,
      };
    } catch (error) {
      return {
        key: null,
        albums: [],
        chosen: null,
        error:
          error instanceof Error
            ? error.message
            : "Album context is unavailable.",
      };
    }
  }, [
    props.scope,
    props.matches,
    props.photos,
    props.allowed,
    props.selection,
    props.timeZone,
  ]);
  const chosen = model.chosen;
  const photo =
    opened?.scopeKey === model.key && opened?.matchId === chosen?.matchId
      ? (chosen?.photos.find((item) => item.id === opened.photoId) ?? null)
      : null;
  const choose = (matchId: string) => {
    props.onSelect(
      selectAlbum(props.scope, props.matches, matchId, props.allowed),
    );
    setOpened(null);
  };
  if (photo && chosen) {
    return (
      <Card>
        <View style={styles.stack} testID="album-selected-game">
          <View style={styles.stack} testID="album-photo-viewer">
            <View style={{ alignSelf: "flex-start" }}>
              <Button
                label="Back to album"
                accessibilityLabel="Close photo; return to this album"
                testID="album-close-photo"
                compact
                variant="secondary"
                onPress={() => setOpened(null)}
              />
            </View>
            <Text style={typography.label}>
              {chosen.label} ·{" "}
              {chosen.playedDate
                ? formatUkDate(chosen.playedDate)
                : "Played date not recorded"}
            </Text>
            <Text style={typography.body}>
              {photo.caption || "No caption recorded"}
            </Text>
            {props.renderPhoto ? (
              props.renderPhoto(photo)
            ) : (
              <Notice>
                This photo could not be opened. Close it and try again after
                refreshing your team view.
              </Notice>
            )}
          </View>
        </View>
      </Card>
    );
  }
  return (
    <Card>
      <Text style={typography.section}>Game albums</Text>
      <Text style={typography.body}>
        Choose a game to see its published photos.
      </Text>
      <Text style={typography.muted}>
        Game dates ·{" "}
        {!props.timeZone || props.timeZone === "Europe/London"
          ? "UK time"
          : props.timeZone}
      </Text>
      {model.error && <Notice tone="error">{model.error}</Notice>}
      {!props.allowed && (
        <Notice tone="warning">
          Your access to these photos could not be confirmed. Check your
          invitation or choose another team.
        </Notice>
      )}
      {props.allowed && !model.error && model.albums.length === 0 && (
        <Notice>
          No published game albums are available here yet. Unpublished photos
          stay private.
        </Notice>
      )}
      {model.albums.map((album) => (
        <View key={album.matchId} style={styles.album}>
          <Button
            testID={`album-game-${album.matchId}`}
            label={`${album.playedDate ? formatUkDate(album.playedDate) : "Played date not recorded"} · ${album.label} · ${album.photoCount} ${album.photoCount === 1 ? "photo" : "photos"}${chosen?.matchId === album.matchId ? " · selected" : ""}`}
            variant={
              chosen?.matchId === album.matchId ? "primary" : "secondary"
            }
            accessibilityState={{ selected: chosen?.matchId === album.matchId }}
            disabled={props.disabled}
            onPress={() => choose(album.matchId)}
          />
        </View>
      ))}
      {!chosen && props.allowed && model.albums.length > 0 && (
        <Notice>
          {props.scope.role === "spectator"
            ? "Choose a game above to open its photos."
            : "Choose a game before uploading. Your upload will stay with that game."}
        </Notice>
      )}
      {chosen && (
        <View style={styles.stack} testID="album-selected-game">
          <Pill tone="info">
            {chosen.playedDate
              ? formatUkDate(chosen.playedDate)
              : "PLAYED DATE NOT RECORDED"}{" "}
            · {chosen.photoCount} PUBLISHED{" "}
            {chosen.photoCount === 1 ? "PHOTO" : "PHOTOS"}
          </Pill>
          <Text style={typography.section}>{chosen.label}</Text>
          <Text style={typography.muted}>
            {props.scope.role === "spectator"
              ? "Published photos for this game."
              : "New uploads will belong to this game. Submitting a photo and publishing it are separate steps."}
          </Text>
          <Button
            label="Close selected album"
            testID="album-clear-selection"
            variant="quiet"
            disabled={props.disabled}
            onPress={() => {
              props.onSelect(null);
              setOpened(null);
            }}
          />
          {chosen.photos.length === 0 && (
            <Text style={typography.muted}>
              No published photos for this game yet. Pending submissions stay
              private.
            </Text>
          )}
          <View style={styles.grid}>
            {chosen.photos.map((item, index) => (
              <View
                key={`${model.key}:${chosen.matchId}:${item.id}:${item.version}`}
                style={styles.cell}
              >
                {props.renderThumbnail?.(item)}
                <Button
                  testID={`album-photo-${item.id}`}
                  label={`Open photo ${index + 1}`}
                  accessibilityLabel={`Open photo ${index + 1}${item.caption ? ` · ${item.caption}` : ""}`}
                  variant="secondary"
                  accessibilityState={{ expanded: false }}
                  onPress={() =>
                    setOpened({
                      scopeKey: model.key!,
                      matchId: chosen.matchId,
                      photoId: item.id,
                    })
                  }
                  disabled={props.disabled}
                />
                <Text style={typography.muted}>{item.uploaderLabel}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </Card>
  );
}
const styles = StyleSheet.create({
  stack: { gap: 12 },
  album: { gap: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  cell: {
    width: "48%",
    flexGrow: 0,
    flexShrink: 0,
    gap: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.canvas,
  },
});
