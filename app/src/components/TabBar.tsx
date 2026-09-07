import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { colors, space } from '../theme';
import { IconDots, IconPlus, StatusDot } from '../icons';
import { Chip, IconButton } from './Primitives';
import { Tab } from '../types';

export function TabBar({
  tabs,
  activeTabId,
  busyTabIds,
  onSelect,
  onNewTab,
  onOpenMenu,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  busyTabIds: Set<string>;
  onSelect: (tabId: string) => void;
  onNewTab: () => void;
  onOpenMenu: () => void;
}) {
  return (
    <View style={styles.bar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {tabs.map((tab) => (
          <Chip
            key={tab.tab_id}
            label={tab.label || `Scheda ${tab.number}`}
            variant="plain"
            active={tab.tab_id === activeTabId}
            onPress={() => onSelect(tab.tab_id)}
            trailing={busyTabIds.has(tab.tab_id) ? <StatusDot size={5} color={colors.online} /> : undefined}
          />
        ))}
      </ScrollView>

      <View style={styles.actions}>
        <IconButton accessibilityLabel="Nuova scheda" onPress={onNewTab} size={32}>
          <IconPlus size={15} color={colors.textMuted} />
        </IconButton>
        <IconButton accessibilityLabel="Altre azioni" onPress={onOpenMenu} size={32}>
          <IconDots size={16} color={colors.textMuted} />
        </IconButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  scrollContent: {
    alignItems: 'center',
    gap: 6,
    paddingRight: space.sm,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
