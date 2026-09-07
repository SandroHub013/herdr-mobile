import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { IconClose } from '../icons';
import { UpdateState } from '../hooks/useAppUpdate';
import { formatSize } from '../updates';
import { IconButton, PrimaryButton } from './Primitives';

/**
 * One line under the header when a newer build is on the bridge.
 *
 * It says what is new and how big it is, and does nothing until asked. While
 * the package downloads the same line becomes a progress bar; once the
 * installer has been opened it stays, so a dismissed system prompt can be
 * brought back without downloading again.
 */
export function UpdateBanner({
  state,
  onUpdate,
  onDismiss,
}: {
  state: UpdateState;
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  if (state.status === 'idle') return null;

  const { release, apk } = state;
  // The button says what happens; the title only has to say which version.
  const title = `Versione ${release.version}`;

  if (state.status === 'downloading') {
    const percent = Math.round(state.progress * 100);
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite">
        <View style={styles.text}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.detail}>
            Scaricamento, {percent}% di {formatSize(apk.size)}
          </Text>
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: percent }}
          >
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
        </View>
      </View>
    );
  }

  const detail =
    state.status === 'failed'
      ? state.message
      : state.status === 'ready'
        ? 'Pacchetto pronto. Conferma quando Android lo chiede.'
        : release.notes || `${formatSize(apk.size)} da scaricare`;

  const action = state.status === 'ready' ? 'Installa' : state.status === 'failed' ? 'Riprova' : 'Aggiorna';

  return (
    <View style={styles.banner}>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.detail, state.status === 'failed' && styles.detailFailed]} numberOfLines={2}>
          {detail}
        </Text>
      </View>
      <PrimaryButton label={action} onPress={onUpdate} />
      <IconButton accessibilityLabel="Più tardi" onPress={onDismiss} size={30} style={styles.dismiss}>
        <IconClose size={12} color={colors.textMuted} />
      </IconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginBottom: space.sm,
    paddingVertical: 10,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  title: {
    ...type.label,
    fontWeight: '600',
    color: colors.text,
  },
  detail: {
    ...type.caption,
    fontWeight: '400',
    color: colors.textMuted,
    lineHeight: 16,
  },
  detailFailed: {
    color: colors.danger,
  },
  dismiss: {
    marginLeft: -2,
  },
  track: {
    height: 4,
    marginTop: 6,
    borderRadius: 2,
    backgroundColor: colors.surfaceActive,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.accent,
  },
});
