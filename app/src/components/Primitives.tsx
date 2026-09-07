import React from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native';
import { colors, radius, space, type, HIT_SLOP } from '../theme';

/** A square, borderless control that holds a drawn icon. */
export function IconButton({
  children,
  onPress,
  size = 36,
  disabled = false,
  accessibilityLabel,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  size?: number;
  disabled?: boolean;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? colors.surfaceActive : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/** A compact labelled control. Used for tabs, keyboard keys and presets. */
export function Chip({
  label,
  onPress,
  active = false,
  disabled = false,
  mono = false,
  variant = 'filled',
  leading,
  trailing,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  mono?: boolean;
  /** "plain" chips carry no fill until they are selected, which is what makes a selected tab obvious. */
  variant?: 'filled' | 'plain';
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        variant === 'plain' && styles.chipPlain,
        active && styles.chipActive,
        pressed && !active && styles.chipPressed,
        disabled && styles.chipDisabled,
      ]}
    >
      {leading}
      <Text
        numberOfLines={1}
        style={[styles.chipLabel, mono && { fontFamily: type.mono.fontFamily }, active && styles.chipLabelActive]}
      >
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

/** Filled call to action. One per dialog. */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && { opacity: 0.85 },
        disabled && { backgroundColor: colors.surfaceActive },
      ]}
    >
      <Text style={[styles.primaryLabel, disabled && { color: colors.textFaint }]}>{label}</Text>
    </Pressable>
  );
}

/** Text-only action, for the secondary half of a dialog. */
export function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.textButtonLabel}>{label}</Text>
    </Pressable>
  );
}

export function SectionLabel({ title, trailing }: { title: string; trailing?: React.ReactNode }) {
  return (
    <View style={styles.sectionLabel}>
      <Text style={styles.sectionLabelText}>{title.toUpperCase()}</Text>
      {trailing}
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

/** Centred placeholder for an area with nothing to show. */
export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {detail ? <Text style={styles.emptyDetail}>{detail}</Text> : null}
      {action ? <View style={{ marginTop: space.lg }}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
  },
  chipPlain: {
    backgroundColor: 'transparent',
  },
  chipActive: {
    backgroundColor: colors.surfaceActive,
  },
  chipPressed: {
    backgroundColor: colors.surfaceActive,
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipLabel: {
    ...type.caption,
    color: colors.textMuted,
  },
  chipLabelActive: {
    color: colors.text,
    fontWeight: '600',
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: 11,
    paddingHorizontal: 20,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  primaryLabel: {
    ...type.label,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  textButton: {
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  textButtonLabel: {
    ...type.label,
    color: colors.textMuted,
  },
  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  sectionLabelText: {
    ...type.section,
    color: colors.textFaint,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
  },
  emptyTitle: {
    ...type.label,
    color: colors.textMuted,
    textAlign: 'center',
  },
  emptyDetail: {
    ...type.caption,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 17,
  },
});
