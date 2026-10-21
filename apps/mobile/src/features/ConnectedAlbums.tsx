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
      const albums = groupPermittedAlbums(
        props.matches,
        props.photos,
        props.allowed,
        props.timeZone,
      );
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
  return (
    <Card>
      <Text style={typography.section}>Game albums</Text>
      <Text style={typography.body}>
        Choose the actual game. Albums use the game’s played date and contain
        only photos this service view permits you to see.
      </Text>
      <Text style={typography.muted}>
        Game dates use {props.timeZone ?? "Europe/London"} team time.
      </Text>
      {model.error && <Notice tone="error">{model.error}</Notice>}
      {!props.allowed && (
        <Notice tone="warning">
          Current team or season access is unavailable. Album context,
          thumbnails and full images stay closed.
        </Notice>
      )}
      {props.allowed && !model.error && model.albums.length === 0 && (
        <Notice>
          No game album is currently permitted for this account. Withheld match
          context and unpublished photos are not included.
        </Notice>
      )}
      {model.albums.map((album) => (
        <View key={album.matchId} style={styles.album}>
          <Button
            testID={`album-game-${album.matchId}`}
            label={`${album.playedDate ?? "Played date not recorded"} · ${album.label} · ${album.photoCount} ${album.photoCount === 1 ? "photo" : "photos"}${chosen?.matchId === album.matchId ? " · selected" : ""}`}
            variant={
              chosen?.matchId === album.matchId ? "primary" : "secondary"
            }
            disabled={props.disabled}
            onPress={() => choose(album.matchId)}
          />
        </View>
      ))}
      {!chosen && props.allowed && model.albums.length > 0 && (
        <Notice>
          {props.scope.role === "spectator"
            ? "Select a permitted game to browse its published album."
            : "Select a permitted game explicitly before uploading. No game is selected automatically."}
        </Notice>
      )}
      {chosen && (
        <View style={styles.stack} testID="album-selected-game">
          <Pill tone="info">
            {chosen.playedDate ?? "PLAYED DATE NOT RECORDED"} ·{" "}
            {chosen.photoCount} PUBLISHED{" "}
            {chosen.photoCount === 1 ? "PHOTO" : "PHOTOS"}
          </Pill>
          <Text style={typography.section}>{chosen.label}</Text>
          <Text style={typography.muted}>
            {props.scope.role === "spectator"
              ? "Published photos only. Current access is checked for each thumbnail and full image."
              : "New upload target: this game. A retained upload remains bound to the game captured when it was prepared. Publication and moderation stay separate actions."}
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
              No published photos are visible in this game album. Pending or
              private submissions do not increase its count.
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
                  label={`Open photo ${index + 1}${item.caption ? ` · ${item.caption}` : ""}`}
                  variant={photo?.id === item.id ? "primary" : "secondary"}
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
          {photo && (
            <View
              style={styles.viewer}
              key={`${model.key}:${chosen.matchId}:${photo.id}:${photo.version}`}
              testID="album-photo-viewer"
            >
              <Text style={typography.label}>
                {chosen.label} ·{" "}
                {chosen.playedDate ?? "Played date not recorded"}
              </Text>
              <Text style={typography.body}>
                {photo.caption || "No caption recorded"}
              </Text>
              {props.renderPhoto ? (
                props.renderPhoto(photo)
              ) : (
                <Notice>
                  Open this photo through the authenticated media gateway. A
                  published listing does not bypass its current access check.
                </Notice>
              )}
              <Button
                label="Close photo; return to this album"
                testID="album-close-photo"
                variant="quiet"
                onPress={() => setOpened(null)}
              />
            </View>
          )}
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
  viewer: {
    gap: 12,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 12,
  },
});
