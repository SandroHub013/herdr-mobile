import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ToolCall } from '../../domain/events';
import { colors, radius, space, type } from '../../theme';
import { Sheet } from './Sheet';
import { ToolDetail } from './ToolGroup';

/**
 * Work the agent left running.
 *
 * The point of the list is the clock: a build that has been going four minutes
 * is a different thing from one that has been going forty, and the only way to
 * know is to watch it count. Runs that have finished stay, collapsed, because
 * the question is usually "did that ever finish" rather than "what is running".
 */

/** The timer ticks once a second; nothing else on this screen needs to. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** "4m 12s", "1h 03m" — the shape the reader is watching for. */
function elapsed(fromISO: string, toMillis: number): string {
  const from = Date.parse(fromISO);
  if (Number.isNaN(from)) return '';
  const seconds = Math.max(0, Math.round((toMillis - from) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const kindLabel = (call: ToolCall) => (call.kind === 'shell' ? 'Shell' : call.name);

function Run({
  call,
  now,
  onOpen,
  onStop,
}: {
  call: ToolCall;
  now: number;
  onOpen: () => void;
  onStop?: () => void;
}) {
  const run = call.background!;
  const running = !run.endedAt;
  const duration = elapsed(run.startedAt, running ? now : Date.parse(run.endedAt!));

  return (
    <Pressable style={styles.run} onPress={onOpen}>
      <View style={styles.runBody}>
        <Text style={styles.runTitle} numberOfLines={2}>
          {call.title}
        </Text>
        <Text style={styles.runMeta}>
          {kindLabel(call)}
          {'   '}
          <Text style={running ? styles.durationLive : styles.duration}>{duration}</Text>
          {call.status === 'error' && !running ? '   fallita' : ''}
        </Text>
      </View>

      {running && onStop ? (
        <Pressable style={styles.stop} onPress={onStop} hitSlop={8}>
          <View style={styles.stopMark} />
        </Pressable>
      ) : (
        <Text style={styles.chevron}>›</Text>
      )}
    </Pressable>
  );
}

/** The line in the feed that opens the list. */
export function BackgroundBadge({ running, onPress }: { running: number; onPress: () => void }) {
  if (running === 0) return null;
  return (
    <Pressable style={styles.badge} onPress={onPress}>
      <View style={styles.pulse} />
      <Text style={styles.badgeText}>
        {running === 1 ? '1 attività in esecuzione' : `${running} attività in esecuzione`}
      </Text>
    </Pressable>
  );
}

export function BackgroundSheet({
  visible,
  calls,
  onClose,
  onStop,
}: {
  visible: boolean;
  calls: readonly ToolCall[];
  onClose: () => void;
  onStop?: (call: ToolCall) => void;
}) {
  const [detail, setDetail] = useState<ToolCall | null>(null);
  const running = calls.filter((call) => !call.background?.endedAt);
  const done = calls.filter((call) => call.background?.endedAt);
  const now = useNow(visible && running.length > 0);

  return (
    <>
      <Sheet visible={visible} title="Attività in background" onClose={onClose}>
        {running.length > 0 && (
          <>
            <Text style={styles.section}>IN ESECUZIONE</Text>
            {running.map((call) => (
              <Run
                key={call.id}
                call={call}
                now={now}
                onOpen={() => setDetail(call)}
                onStop={onStop ? () => onStop(call) : undefined}
              />
            ))}
          </>
        )}

        {done.length > 0 && (
          <>
            <Text style={[styles.section, running.length > 0 && styles.sectionSpaced]}>
              COMPLETATE {done.length}
            </Text>
            {done
              .slice()
              .reverse()
              .map((call) => (
                <Run key={call.id} call={call} now={now} onOpen={() => setDetail(call)} />
              ))}
          </>
        )}

        {calls.length === 0 && (
          <Text style={styles.empty}>Nessuna attività in background in questa sessione.</Text>
        )}
      </Sheet>

      <ToolDetail call={detail} onClose={() => setDetail(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
  },
  pulse: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.busy },
  badgeText: { ...type.meta, color: colors.accent },

  section: { ...type.section, color: colors.textFaint, marginBottom: space.sm },
  sectionSpaced: { marginTop: space.xl },

  run: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
  },
  runBody: { flex: 1 },
  runTitle: { ...type.label, color: colors.text, lineHeight: 19 },
  runMeta: { ...type.caption, color: colors.textFaint, marginTop: space.xs },
  duration: { color: colors.textMuted, fontVariant: ['tabular-nums'] },
  durationLive: { color: colors.busy, fontVariant: ['tabular-nums'] },

  stop: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopMark: { width: 9, height: 9, borderRadius: 1.5, backgroundColor: colors.textMuted },
  chevron: { fontSize: 18, color: colors.textFaint },

  empty: { ...type.body, color: colors.textFaint, paddingVertical: space.lg },
});
