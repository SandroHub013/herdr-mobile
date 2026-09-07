import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, space, type } from '../theme';
import { LastCheck, UpdateState } from '../hooks/useAppUpdate';
import { installedBuild, installedVersion } from '../updates';
import { Chip } from './Primitives';

/**
 * The installed version, what the last look at the bridge found, and a way
 * to look again without waiting for the hourly check. It sits in the
 * connection dialog because the bridge is where updates come from.
 *
 * Once a newer build is known the control turns into the same action the
 * banner offers, so the update can be started from here as well.
 */
export function VersionRow({
  state,
  lastCheck,
  onCheck,
  onUpdate,
}: {
  state: UpdateState;
  lastCheck: LastCheck | null;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  const checking = lastCheck?.status === 'checking';
  const pending = state.status !== 'idle';
  const action =
    state.status === 'downloading'
      ? null
      : state.status === 'ready'
        ? 'Installa'
        : state.status === 'failed'
          ? 'Riprova'
          : state.status === 'available'
            ? 'Aggiorna'
            : 'Cerca aggiornamenti';

  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          Herdr Mobile {installedVersion()}
        </Text>
        <Text
          style={[styles.detail, state.status === 'failed' && styles.detailFailed]}
          numberOfLines={2}
          accessibilityLiveRegion="polite"
        >
          {describe(state, lastCheck)}
        </Text>
      </View>
      {action ? (
        <Chip label={action} active={pending} disabled={checking} onPress={pending ? onUpdate : onCheck} />
      ) : null}
    </View>
  );
}

function describe(state: UpdateState, lastCheck: LastCheck | null): string {
  switch (state.status) {
    case 'downloading':
      return `Scaricamento, ${Math.round(state.progress * 100)}%`;
    case 'ready':
      return `Versione ${state.release.version} pronta da installare`;
    case 'failed':
      return state.message;
    case 'available':
      return `Versione ${state.release.version} disponibile`;
    case 'idle':
      break;
  }
  if (!lastCheck) return `Build ${installedBuild()}`;
  switch (lastCheck.status) {
    case 'checking':
      return 'Controllo sul bridge';
    case 'latest':
      return `Sei aggiornato · ${clock(lastCheck.at)}`;
    case 'newer':
      return `Versione ${lastCheck.release.version} disponibile`;
    case 'unreachable':
      return `Bridge non risponde · ${clock(lastCheck.at)}`;
  }
}

function clock(at: number): string {
  const date = new Date(at);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...type.label,
    color: colors.text,
  },
  detail: {
    ...type.caption,
    fontWeight: '400',
    color: colors.textMuted,
    marginTop: 2,
    lineHeight: 16,
  },
  detailFailed: {
    color: colors.danger,
  },
});
