import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { IconArrowUp, IconChevron, IconClose, IconPlus } from '../icons';
import { Chip, IconButton } from './Primitives';
import { Attachment } from '../types';

export type ComposerKey = 'escape' | 'ctrl-c' | 'enter' | 'tab' | 'history-prev' | 'history-next' | 'clear';

export function Composer({
  value,
  onChangeText,
  onSend,
  onKey,
  onAttach,
  onRemoveAttachment,
  attachment,
  targetLabel,
  disabled,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onKey: (key: ComposerKey) => void;
  onAttach: () => void;
  onRemoveAttachment: () => void;
  attachment: Attachment | null;
  targetLabel: string | null;
  disabled: boolean;
}) {
  const canSend = value.trim().length > 0 && !disabled;

  return (
    <View style={styles.wrapper}>
      {attachment ? (
        <View style={styles.attachment}>
          <Text numberOfLines={1} style={styles.attachmentName}>
            {attachment.name}
          </Text>
          {attachment.state === 'uploading' ? (
            <View style={styles.attachmentState}>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text style={styles.attachmentStateText}>Caricamento</Text>
            </View>
          ) : (
            <Text
              style={[
                styles.attachmentStateText,
                attachment.state === 'failed' && { color: colors.danger },
              ]}
            >
              {attachment.state === 'failed' ? 'Non riuscito' : 'Pronto'}
            </Text>
          )}
          <IconButton accessibilityLabel="Rimuovi l'allegato" onPress={onRemoveAttachment} size={26}>
            <IconClose size={12} color={colors.textMuted} />
          </IconButton>
        </View>
      ) : null}

      <View style={styles.card}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={targetLabel ? `Scrivi a ${targetLabel}` : 'Scrivi un comando'}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          editable={!disabled}
          returnKeyType="send"
          submitBehavior="submit"
          onSubmitEditing={onSend}
          accessibilityLabel="Comando o prompt da inviare"
        />

        <View style={styles.actions}>
          <IconButton
            accessibilityLabel="Allega un file"
            onPress={onAttach}
            size={34}
            disabled={disabled}
            style={styles.round}
          >
            <IconPlus size={15} color={colors.textMuted} />
          </IconButton>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.keys}
            style={styles.keysScroll}
          >
            <Chip label="Esc" mono onPress={() => onKey('escape')} disabled={disabled} />
            <Chip label="^C" mono onPress={() => onKey('ctrl-c')} disabled={disabled} />
            <Chip label="Invio" onPress={() => onKey('enter')} disabled={disabled} />
            <Chip label="Tab" mono onPress={() => onKey('tab')} disabled={disabled} />
            <Chip
              label="Prec."
              onPress={() => onKey('history-prev')}
              leading={<IconChevron size={11} direction="up" color={colors.textMuted} />}
            />
            <Chip
              label="Succ."
              onPress={() => onKey('history-next')}
              leading={<IconChevron size={11} direction="down" color={colors.textMuted} />}
            />
            <Chip label="Clear" mono onPress={() => onKey('clear')} disabled={disabled} />
          </ScrollView>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Invia"
            accessibilityState={{ disabled: !canSend }}
            onPress={onSend}
            disabled={!canSend}
            style={({ pressed }) => [
              styles.send,
              canSend ? styles.sendActive : styles.sendIdle,
              pressed && canSend && { opacity: 0.85 },
            ]}
          >
            <IconArrowUp size={16} color={canSend ? '#FFFFFF' : colors.textFaint} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  attachment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: 4,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  attachmentName: {
    ...type.caption,
    color: colors.text,
    flex: 1,
  },
  attachmentState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  attachmentStateText: {
    ...type.caption,
    fontSize: 11,
    color: colors.textFaint,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 6,
  },
  input: {
    ...type.body,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingTop: 10,
    paddingBottom: 8,
    minHeight: 40,
    maxHeight: 132,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  round: {
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
  },
  keysScroll: {
    flex: 1,
  },
  keys: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 2,
  },
  send: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendActive: {
    backgroundColor: colors.accent,
  },
  sendIdle: {
    backgroundColor: colors.surfaceRaised,
  },
});
