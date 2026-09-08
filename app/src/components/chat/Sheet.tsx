import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, HIT_SLOP, radius, space, type } from '../../theme';

/**
 * A panel that comes up from the bottom.
 *
 * Everything that is not the conversation lives in one of these: the calls
 * behind a tool row, a diff, the tasks still running, the model list. The
 * conversation stays where it was, which is what lets the reader look at a
 * change and go straight back to the sentence that mentioned it.
 */
export function Sheet({
  visible,
  title,
  subtitle,
  onClose,
  children,
  /** For a sheet whose body scrolls itself, such as a long diff. */
  flush = false,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  flush?: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Tapping the dimmed area closes: the usual way out of a sheet. */}
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.grabber} />
        <View style={styles.head}>
          <Pressable onPress={onClose} hitSlop={HIT_SLOP} style={styles.close}>
            <Text style={styles.closeMark}>✕</Text>
          </Pressable>
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {/* Balances the close button so the title sits centred. */}
          <View style={styles.close} />
        </View>

        {flush ? (
          <View style={styles.flush}>{children}</View>
        ) : (
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceActive,
    marginTop: space.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  close: { width: 40, alignItems: 'center' },
  closeMark: { fontSize: 17, color: colors.textMuted },
  titles: { flex: 1, alignItems: 'center' },
  title: { ...type.title, color: colors.text },
  subtitle: { ...type.caption, color: colors.textFaint, marginTop: 1 },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: space.lg, paddingTop: space.sm },
  flush: { flexShrink: 1 },
});
