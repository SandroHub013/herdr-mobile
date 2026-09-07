import React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, HIT_SLOP, radius, space, type } from '../theme';
import { IconArrowUp, IconChevron, IconClose, IconPlus } from '../icons';
import { extensionLabel } from '../files';
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
  attachments,
  targetLabel,
  disabled,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onKey: (key: ComposerKey) => void;
  onAttach: () => void;
  onRemoveAttachment: (id: number) => void;
  attachments: Attachment[];
  targetLabel: string | null;
  disabled: boolean;
}) {
  // A message leaves with every reference in it, so it waits for uploads still on their way.
  const uploading = attachments.some((item) => item.state === 'uploading');
  const canSend = value.trim().length > 0 && !disabled && !uploading;

  return (
    <View style={styles.wrapper}>
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          contentContainerStyle={styles.attachments}
        >
          {attachments.map((item) => (
            <AttachmentTile key={item.id} attachment={item} onRemove={() => onRemoveAttachment(item.id)} />
          ))}
        </ScrollView>
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

/**
 * One attachment waiting to be sent: the picture itself when it is one, the
 * file's kind and name otherwise, with the upload's state laid over it and a
 * way to take it back.
 */
function AttachmentTile({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const uploading = attachment.state === 'uploading';
  const failed = attachment.state === 'failed';

  return (
    <View style={styles.tile} accessibilityLabel={`${attachment.name}, ${describeState(attachment.state)}`}>
      {attachment.kind === 'image' ? (
        <Image source={{ uri: attachment.uri }} style={styles.tileImage} resizeMode="cover" />
      ) : (
        <View style={styles.tileFile}>
          <Text style={styles.tileBadge}>{extensionLabel(attachment.name)}</Text>
          <Text numberOfLines={2} style={styles.tileName}>
            {attachment.name}
          </Text>
        </View>
      )}

      {uploading ? (
        <View style={styles.tileVeil}>
          <ActivityIndicator size="small" color={colors.text} />
        </View>
      ) : null}
      {failed ? (
        <View style={[styles.tileVeil, styles.tileFailed]}>
          <Text style={styles.tileFailedText}>Non caricato</Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Rimuovi ${attachment.name}`}
        onPress={onRemove}
        hitSlop={HIT_SLOP}
        style={({ pressed }) => [styles.tileRemove, pressed && { opacity: 0.7 }]}
      >
        <IconClose size={11} color={colors.background} />
      </Pressable>
    </View>
  );
}

function describeState(state: Attachment['state']): string {
  switch (state) {
    case 'uploading':
      return 'in caricamento';
    case 'ready':
      return 'pronto';
    case 'failed':
      return 'non caricato';
  }
}

const TILE = 84;

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  attachments: {
    gap: space.sm,
    paddingHorizontal: 2,
    paddingTop: 2,
  },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  tileFile: {
    flex: 1,
    padding: space.sm,
    gap: 4,
    justifyContent: 'flex-end',
  },
  tileBadge: {
    ...type.section,
    fontSize: 10,
    color: colors.textMuted,
  },
  tileName: {
    ...type.caption,
    fontSize: 10.5,
    lineHeight: 13,
    color: colors.text,
  },
  tileVeil: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 13, 0.55)',
  },
  tileFailed: {
    padding: space.xs,
  },
  tileFailedText: {
    ...type.caption,
    fontSize: 10.5,
    color: colors.danger,
    textAlign: 'center',
  },
  tileRemove: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.text,
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
