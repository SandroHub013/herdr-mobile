import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { colors } from './theme';

/**
 * Icons drawn from plain views.
 *
 * Glyph icons (☰, ◫, ⤢, ✕) are a liability on Android: any font that lacks the
 * codepoint renders an empty box. These cost nothing, scale cleanly and always
 * look the same on every device.
 */

interface IconProps {
  size?: number;
  color?: string;
}

const STROKE = 1.6;

export function IconMenu({ size = 18, color = colors.text }: IconProps) {
  const bar: ViewStyle = { width: size, height: STROKE, borderRadius: STROKE, backgroundColor: color };
  return (
    <View style={{ width: size, height: size * 0.72, justifyContent: 'space-between' }}>
      <View style={bar} />
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

export function IconClose({ size = 14, color = colors.textMuted }: IconProps) {
  const bar: ViewStyle = {
    position: 'absolute',
    width: size,
    height: STROKE,
    borderRadius: STROKE,
    backgroundColor: color,
  };
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View style={[bar, { transform: [{ rotate: '45deg' }] }]} />
      <View style={[bar, { transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}

export function IconPlus({ size = 16, color = colors.text }: IconProps) {
  const bar: ViewStyle = {
    position: 'absolute',
    width: size,
    height: STROKE,
    borderRadius: STROKE,
    backgroundColor: color,
  };
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View style={bar} />
      <View style={[bar, { transform: [{ rotate: '90deg' }] }]} />
    </View>
  );
}

type Direction = 'up' | 'down' | 'left' | 'right';

const CHEVRON_ROTATION: Record<Direction, string> = {
  up: '-135deg',
  down: '45deg',
  left: '135deg',
  right: '-45deg',
};

export function IconChevron({ size = 12, color = colors.textMuted, direction = 'down' }: IconProps & { direction?: Direction }) {
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.58,
          height: size * 0.58,
          borderRightWidth: STROKE,
          borderBottomWidth: STROKE,
          borderColor: color,
          transform: [{ rotate: CHEVRON_ROTATION[direction] }],
        }}
      />
    </View>
  );
}

export function IconArrowUp({ size = 16, color = '#FFFFFF' }: IconProps) {
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View
        style={{
          position: 'absolute',
          width: STROKE + 0.2,
          height: size * 0.7,
          borderRadius: STROKE,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: size * 0.15,
          width: size * 0.44,
          height: size * 0.44,
          borderTopWidth: STROKE + 0.2,
          borderLeftWidth: STROKE + 0.2,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

export function IconDots({ size = 16, color = colors.textMuted }: IconProps) {
  const dot: ViewStyle = { width: 2.8, height: 2.8, borderRadius: 1.4, backgroundColor: color };
  return (
    <View style={[styles.center, { width: size, height: size, flexDirection: 'row', gap: 2.6 }]}>
      <View style={dot} />
      <View style={dot} />
      <View style={dot} />
    </View>
  );
}

/** Two panes side by side. */
export function IconSplitRight({ size = 16, color = colors.textMuted }: IconProps) {
  return (
    <View style={{ width: size, height: size * 0.82, flexDirection: 'row', gap: 2 }}>
      <View style={{ flex: 1, borderWidth: 1.3, borderColor: color, borderRadius: 2 }} />
      <View style={{ flex: 1, borderWidth: 1.3, borderColor: color, borderRadius: 2 }} />
    </View>
  );
}

/** Two panes stacked. */
export function IconSplitDown({ size = 16, color = colors.textMuted }: IconProps) {
  return (
    <View style={{ width: size, height: size * 0.82, gap: 2 }}>
      <View style={{ flex: 1, borderWidth: 1.3, borderColor: color, borderRadius: 2 }} />
      <View style={{ flex: 1, borderWidth: 1.3, borderColor: color, borderRadius: 2 }} />
    </View>
  );
}

/** A single, full-width pane. */
export function IconSinglePane({ size = 16, color = colors.textMuted }: IconProps) {
  return <View style={{ width: size, height: size * 0.82, borderWidth: 1.3, borderColor: color, borderRadius: 2 }} />;
}

export function IconExpand({ size = 14, color = colors.textMuted }: IconProps) {
  const corner: ViewStyle = { position: 'absolute', width: size * 0.42, height: size * 0.42, borderColor: color };
  return (
    <View style={{ width: size, height: size }}>
      <View style={[corner, { top: 0, left: 0, borderTopWidth: STROKE, borderLeftWidth: STROKE }]} />
      <View style={[corner, { bottom: 0, right: 0, borderBottomWidth: STROKE, borderRightWidth: STROKE }]} />
    </View>
  );
}

export function StatusDot({ size = 7, color = colors.textFaint, hollow = false }: IconProps & { hollow?: boolean }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hollow ? 'transparent' : color,
        borderWidth: hollow ? 1.4 : 0,
        borderColor: color,
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
