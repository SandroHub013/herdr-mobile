import React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, HIT_SLOP, radius, space, type } from '../theme';
import { IconArrowUp, IconClose, IconPlus } from '../icons';
import { extensionLabel } from '../files';
import { IconButton } from './Primitives';
import { ControlPill } from './chat/ControlPill';
import { Attachment } from '../types';
import type { Capabilities, Control } from '../domain/events';

export function Composer({
  value,
  onChangeText,
  onSend,
  onAttach,
  onRemoveAttachment,
  onControl,
  onInterrupt,
  attachments,
  capabilities,
  targetLabel,
  busy,
  disabled,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onAttach: () => void;
  onRemoveAttachment: (id: number) => void;
  /** The literal keystrokes the manifest gave for the chosen option. */
  onControl: (control: Control, optionId: string, send: string) => void;
  onInterrupt: () => void;
  attachments: Attachment[];
  /**
   * What the agent in this pane can be asked. Null while it is being fetched,
   * and for a pane that has no agent at all — in both cases there are simply
   * no pills, which is the honest thing to show.
   */
  capabilities: Capabilities | null;
  targetLabel: string | null;
  /** The agent is working: the send button becomes the way to stop it. */
  busy: boolean;
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
          placeholder={
            capabilities?.slashCommands
              ? 'Digita / per i comandi'
              : targetLabel
                ? `Scrivi a ${targetLabel}`
                : 'Scrivi un messaggio'
          }
          placeholderTextColor={colors.textFaint}
          // Prose now, not commands: the corrections that were in the way of
          // typing `ls -la` are the ones that help when writing a sentence.
          autoCapitalize="sentences"
          autoCorrect
          multiline
          editable={!disabled}
          returnKeyType="send"
          submitBehavior="submit"
          onSubmitEditing={onSend}
          accessibilityLabel="Messaggio da inviare all'agente"
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

          {/*
            One pill per control the agent declared, and none otherwise. The
            keys that used to live here — Esc, ^C, Tab — were a terminal's
            controls, not an agent's; stopping is the button on the right now,
            and it sends whatever this particular agent answers to.
          */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.keys}
            style={styles.keysScroll}
          >
            {(capabilities?.controls ?? []).map((control) => (
              <ControlPill
                key={control.id}
                control={control}
                disabled={disabled}
                onPick={(optionId, send) => onControl(control, optionId, send)}
              />
            ))}
          </ScrollView>

          {busy ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ferma l'agente"
              onPress={onInterrupt}
              style={({ pressed }) => [styles.send, styles.sendStop, pressed && { opacity: 0.85 }]}
            >
              <View style={styles.stopMark} />
            </Pressable>
          ) : (
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
          )}
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
  /** Stopping is the one destructive thing on the bar, and it says so. */
  sendStop: {
    backgroundColor: colors.danger,
  },
  stopMark: {
    width: 11,
    height: 11,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
});
