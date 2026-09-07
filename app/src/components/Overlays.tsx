import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, space, type } from '../theme';

export interface SheetAction {
  key: string;
  label: string;
  detail?: string;
  icon?: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

/**
 * Bottom sheet for secondary commands. Keeping split, zoom and close in here is
 * what lets the main screen stay down to a header, the tabs and the terminal.
 */
export function ActionSheet({
  visible,
  title,
  actions,
  bottomInset,
  onClose,
}: {
  visible: boolean;
  title: string;
  actions: SheetAction[];
  bottomInset: number;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Chiudi il menu" />
      <View style={[styles.sheet, { paddingBottom: bottomInset + space.md }]}>
        <View style={styles.grabber} />
        <Text style={styles.sheetTitle}>{title}</Text>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled: action.disabled }}
            disabled={action.disabled}
            onPress={() => {
              onClose();
              action.onPress();
            }}
            style={({ pressed }) => [
              styles.sheetRow,
              pressed && { backgroundColor: colors.surfaceRaised },
              action.disabled && { opacity: 0.35 },
            ]}
          >
            {action.icon ? <View style={styles.sheetIcon}>{action.icon}</View> : <View style={styles.sheetIcon} />}
            <View style={styles.sheetTextBlock}>
              <Text style={[styles.sheetLabel, action.destructive && { color: colors.danger }]}>{action.label}</Text>
              {action.detail ? <Text style={styles.sheetDetail}>{action.detail}</Text> : null}
            </View>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

/** Centred dialog used for the two forms in the app. */
export function Dialog({
  visible,
  title,
  children,
  footer,
  onClose,
}: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.dialogRoot}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Chiudi la finestra" />
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>{title}</Text>
          {children}
          <View style={styles.dialogFooter}>{footer}</View>
        </View>
      </View>
    </Modal>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  autoFocus,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  keyboardType?: 'default' | 'numeric';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        keyboardType={keyboardType}
        accessibilityLabel={label}
      />
    </View>
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
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceActive,
    marginBottom: space.md,
  },
  sheetTitle: {
    ...type.section,
    color: colors.textFaint,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 13,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
  },
  sheetIcon: {
    width: 18,
    alignItems: 'center',
  },
  sheetTextBlock: {
    flex: 1,
  },
  sheetLabel: {
    ...type.label,
    fontSize: 14,
    color: colors.text,
  },
  sheetDetail: {
    ...type.caption,
    fontSize: 11,
    color: colors.textFaint,
    marginTop: 2,
  },
  dialogRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    backgroundColor: colors.scrim,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.xl,
  },
  dialogTitle: {
    ...type.title,
    color: colors.text,
    marginBottom: space.lg,
  },
  dialogFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.lg,
  },
  field: {
    marginBottom: space.md,
  },
  fieldLabel: {
    ...type.caption,
    color: colors.textMuted,
    marginBottom: 6,
  },
  fieldInput: {
    ...type.body,
    color: colors.text,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 11,
  },
});
