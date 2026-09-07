import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { IconMenu, StatusDot } from '../icons';
import { IconButton } from './Primitives';

export function Header({
  title,
  branch,
  connected,
  showMenuButton,
  onOpenMenu,
  onOpenConnection,
}: {
  title: string;
  branch?: string;
  connected: boolean;
  showMenuButton: boolean;
  onOpenMenu: () => void;
  onOpenConnection: () => void;
}) {
  return (
    <View style={styles.header}>
      {showMenuButton ? (
        <IconButton accessibilityLabel="Apri gli spazi" onPress={onOpenMenu} style={styles.menuButton}>
          <IconMenu size={17} color={colors.text} />
        </IconButton>
      ) : null}

      <View style={styles.titleBlock}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {branch ? (
          <Text numberOfLines={1} style={styles.branch}>
            {branch}
          </Text>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={connected ? 'Connesso a Herdr. Apri le impostazioni' : 'Non connesso. Apri le impostazioni'}
        onPress={onOpenConnection}
        style={({ pressed }) => [styles.status, pressed && { backgroundColor: colors.surfaceActive }]}
      >
        <StatusDot size={7} color={connected ? colors.online : colors.danger} />
        <Text style={styles.statusLabel}>{connected ? 'Connesso' : 'Offline'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  menuButton: {
    marginLeft: -6,
  },
  titleBlock: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    ...type.title,
    color: colors.text,
  },
  branch: {
    ...type.mono,
    fontSize: 11,
    color: colors.textFaint,
    marginTop: 1,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
  },
  statusLabel: {
    ...type.caption,
    color: colors.textMuted,
  },
});
