import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Control } from '../../domain/events';
import { colors, radius, space, type } from '../../theme';
import { Sheet } from './Sheet';

/**
 * One control the agent declared: a model, a level of effort, a permission
 * mode. Tapping it opens the options the manifest listed and sends the
 * keystrokes that option carries.
 *
 * The bridge has exactly one way to reach an agent — typing at it — so an
 * option with nothing to send is one the agent reports but does not take
 * orders about. Those are shown, because knowing the current permission mode
 * matters, and are not tappable, because a button that silently does nothing
 * is worse than no button.
 */
export function ControlPill({
  control,
  disabled,
  onPick,
}: {
  control: Control;
  disabled?: boolean;
  onPick: (optionId: string, send: string) => void;
}) {
  const [open, setOpen] = useState(false);
  /** What the reader last chose here, falling back to what the agent reports. */
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const current = picked ?? control.current;
  const selected = control.options.find((option) => option.id === current);

  return (
    <>
      <Pressable
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${control.label}: ${selected?.label ?? 'non impostato'}`}
      >
        <Text style={[styles.text, disabled && styles.textDisabled]} numberOfLines={1}>
          {selected?.label ?? control.placeholder ?? control.label}
        </Text>
      </Pressable>

      <Sheet visible={open} title={control.label} onClose={() => setOpen(false)}>
        {control.options.map((option) => {
          const settable = option.send.length > 0;
          const chosen = option.id === current;
          return (
            <Pressable
              key={option.id}
              disabled={!settable}
              style={styles.option}
              onPress={() => {
                setPicked(option.id);
                onPick(option.id, option.send);
                setOpen(false);
              }}
            >
              <View style={styles.optionBody}>
                <Text style={[styles.optionLabel, !settable && styles.optionMuted]}>
                  {option.label}
                </Text>
                {option.note ? <Text style={styles.optionNote}>{option.note}</Text> : null}
              </View>
              {chosen ? <Text style={styles.tick}>✓</Text> : null}
              {!settable && !chosen ? <Text style={styles.readOnly}>solo lettura</Text> : null}
            </Pressable>
          );
        })}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    maxWidth: 170,
  },
  pressed: { backgroundColor: colors.surfaceActive },
  text: { ...type.caption, color: colors.textMuted },
  textDisabled: { color: colors.textFaint },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  optionBody: { flex: 1 },
  optionLabel: { ...type.body, fontSize: 16, color: colors.text },
  optionMuted: { color: colors.textMuted },
  optionNote: { ...type.caption, color: colors.textFaint, marginTop: 2 },
  tick: { fontSize: 16, color: colors.accent },
  readOnly: { ...type.caption, color: colors.textFaint },
});
