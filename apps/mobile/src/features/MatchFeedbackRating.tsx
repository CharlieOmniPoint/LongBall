import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../ui/tokens';

export type MatchFeedbackRatingValue = 1 | 2 | 3 | 4 | 5;

export function MatchFeedbackRating({ value, disabled, onChange }: {
  value: MatchFeedbackRatingValue | null;
  disabled: boolean;
  onChange: (rating: MatchFeedbackRatingValue) => void;
}) {
  const [focused, setFocused] = useState<MatchFeedbackRatingValue | null>(null);
  return <View style={styles.stack}>
    <Text style={typography.label}>Your match rating</Text>
    <Text style={typography.body}>Choose a rating from 1 to 5.</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel="Your match rating" style={styles.choices}>
      {([1, 2, 3, 4, 5] as const).map(rating => <Pressable
        key={rating}
        accessibilityRole="radio"
        accessibilityLabel={`Match rating ${rating} out of 5`}
        accessibilityState={{ checked: value === rating, disabled }}
        testID={`match-feedback-rating-${rating}`}
        disabled={disabled}
        onPress={() => onChange(rating)}
        onFocus={() => setFocused(rating)}
        onBlur={() => setFocused(null)}
        style={({ pressed }) => [styles.choice, value === rating && styles.selected, focused === rating && styles.focused, pressed && styles.pressed, disabled && styles.disabled]}
      >
        <Text style={[typography.section, value === rating && styles.selectedText]}>{rating}</Text>
      </Pressable>)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minWidth: 48, minHeight: 48, borderWidth: 2, borderColor: colors.controlBorder, borderRadius: 8, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.surface },
  selected: { backgroundColor: colors.brand, borderColor: colors.brand },
  selectedText: { color: colors.surface },
  focused: { borderColor: colors.focus },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.55 },
});
