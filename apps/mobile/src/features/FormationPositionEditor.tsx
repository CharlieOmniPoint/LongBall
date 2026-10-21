import { useState } from "react";
import { Text, View } from "react-native";
import {
  positionCodes,
  type FormationSlot,
} from "@longball/application/preparation";
import { normalisedPitchPoint } from "@longball/application/preparation-presentation";
import { Button, Notice, Pitch, typography } from "../ui";

/** Edits a local template draft only. The owning form saves every slot in one existing command. */
export function FormationPositionEditor({
  slots,
  name,
  disabled,
  onMove,
}: {
  slots: FormationSlot[];
  name: string;
  disabled: boolean;
  onMove: (slotId: string, point: { x: number; y: number }) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = slots.find((slot) => slot.id === chosen);
  const ordered = [...slots].sort(
    (a, b) =>
      positionCodes.indexOf(a.position) - positionCodes.indexOf(b.position) ||
      a.id.localeCompare(b.id),
  );
  const place = (point: { x: number; y: number } | null) => {
    if (!disabled && selected && point) onMove(selected.id, point);
  };
  return (
    <View style={{ gap: 12 }} testID="formation-position-editor">
      <Text style={typography.section}>Position the slots</Text>
      <Text style={typography.body}>
        Choose a slot, then tap empty space on the pitch. Moves remain in this
        draft until you save the formation version.
      </Text>
      <Pitch
        lineup={[]}
        players={[]}
        formationName={name}
        positionEditing
        selectedSlot={selected?.id ?? null}
        slots={ordered.map((slot) => ({
          id: slot.id,
          label: slot.label,
          name: `${slot.label}, ${slot.position} role, ${slot.id}`,
          x: slot.x * 100,
          y: slot.y * 100,
        }))}
        onSlotPress={disabled ? undefined : setChosen}
        onPitchPress={
          disabled
            ? undefined
            : (point) =>
                place(
                  normalisedPitchPoint(
                    point.x,
                    point.y,
                    point.width,
                    point.height,
                  ),
                )
        }
      />
      <Notice>
        {selected
          ? `Selected ${selected.label} (${selected.position}). Position ${Math.round(selected.x * 100)}% across, ${Math.round(selected.y * 100)}% down.`
          : "Choose a formation slot on the pitch or in List view. No player or match allocation is changed."}
      </Notice>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {(
          [
            { label: "Left", x: -0.05, y: 0 },
            { label: "Right", x: 0.05, y: 0 },
            { label: "Up", x: 0, y: -0.05 },
            { label: "Down", x: 0, y: 0.05 },
          ] as const
        ).map((move) => (
          <Button
            key={move.label}
            label={`Move selected slot ${move.label.toLowerCase()}`}
            variant="secondary"
            disabled={disabled || !selected}
            onPress={() => {
              if (selected)
                place(
                  normalisedPitchPoint(
                    selected.x + move.x,
                    selected.y + move.y,
                    1,
                    1,
                  ),
                );
            }}
          />
        ))}
      </View>
    </View>
  );
}
